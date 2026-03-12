#!/usr/bin/env node
// bdr_lead_pipeline.js — End-to-end BDR lead cleanup pipeline.
//
// Runs three steps in order:
//   1. Lifecycle Stage Correction — contacts marked "opportunity" with no
//      open deal (by company association or email domain) are reset to "lead".
//   2. ICP Cleanup — non-ICP contacts moved to a target owner with
//      "Not in ICP" status; ICP contacts re-qualified by activity.
//   3. LinkedIn Enrichment — remaining ICP contacts enriched with LinkedIn
//      URLs via PDL-first → Apollo fallback waterfall.
//   4. Contact Type Tagging — sets contact_type = "Prospective Customer"
//      on all owner contacts so BDRs can filter views to prospects only.
//
// Usage:
//   HUBSPOT_ACCESS_TOKEN="..." node scripts/bdr_lead_pipeline.js \
//     --owner-id 89305622 \
//     --target-owner-id 87811681 \
//     [--dry-run] \
//     [--skip-apollo] \
//     [--skip-pdl] \
//     [--skip-lifecycle] \
//     [--skip-icp] \
//     [--skip-enrichment] \
//     [--max-enrich 50] \
//     [--log-file ./pipeline.csv]
//
// Env vars:
//   HUBSPOT_ACCESS_TOKEN  — HubSpot private app token (required)
//   PDL_API               — People Data Labs API key (for enrichment)
//   APOLLO_BULK_MATCH     — Apollo API key (for enrichment fallback)

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// ICP config
// ---------------------------------------------------------------------------

const ICP_SINGLE_TOKENS = ["cfo", "ceo", "controller", "treasurer", "bookkeeper"];

const ICP_COMPOUND_TOKENS = [
  ["senior", "accountant"],
  ["staff", "accountant"],
  ["avp", "accountant"],
  ["director", "finance"],
  ["head", "finance"],
  ["vp", "finance"],
  ["vice", "finance"],
  ["finance", "manager"],
  ["chief", "accounting"],
  ["finance", "officer"],
];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE = "https://api.hubapi.com";
const BATCH_SIZE = 100;
const SEARCH_LIMIT = 100;
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000;

// Active Pipeline — open stages only (not Won/Closed Lost)
const ACTIVE_PIPELINE_ID = "105321581";
const CLOSED_STAGES = ["1166230571", "190380587"]; // Won, Closed/Lost

const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const PDL_KEY = process.env.PDL_API || "";
const APOLLO_KEY = process.env.APOLLO_BULK_MATCH || "";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseCliArgs() {
  const args = process.argv.slice(2);
  const opts = {
    ownerId: null,
    targetOwnerId: null,
    dryRun: false,
    logFile: null,
    skipLifecycle: false,
    skipIcp: false,
    skipEnrichment: false,
    skipApollo: false,
    skipPdl: false,
    maxEnrich: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--owner-id":
        opts.ownerId = args[++i];
        break;
      case "--target-owner-id":
        opts.targetOwnerId = args[++i];
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--log-file":
        opts.logFile = args[++i];
        break;
      case "--skip-lifecycle":
        opts.skipLifecycle = true;
        break;
      case "--skip-icp":
        opts.skipIcp = true;
        break;
      case "--skip-enrichment":
        opts.skipEnrichment = true;
        break;
      case "--skip-apollo":
        opts.skipApollo = true;
        break;
      case "--skip-pdl":
        opts.skipPdl = true;
        break;
      case "--max-enrich":
        opts.maxEnrich = parseInt(args[++i], 10);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!opts.ownerId) {
    console.error("Error: --owner-id is required");
    process.exit(1);
  }
  if (!opts.targetOwnerId && !opts.skipIcp) {
    console.error("Error: --target-owner-id is required (or use --skip-icp)");
    process.exit(1);
  }

  if (!opts.logFile) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    opts.logFile = path.resolve(`bdr_pipeline_${opts.ownerId}_${ts}.csv`);
  } else {
    opts.logFile = path.resolve(opts.logFile);
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hubspotFetch(method, urlPath, body) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(`${BASE}${urlPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      console.log(`  Rate limited — waiting ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      lastError = new Error(`HubSpot ${res.status}: ${text}`);
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        const waitMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        console.log(`  Server error ${res.status} — retrying in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      throw lastError;
    }

    return res.json();
  }
  throw lastError || new Error("Max retries exceeded");
}

async function batchUpdateContacts(inputs) {
  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const chunk = inputs.slice(i, i + BATCH_SIZE);
    await hubspotFetch("POST", "/crm/v3/objects/contacts/batch/update", { inputs: chunk });
    if (i + BATCH_SIZE < inputs.length) await sleep(300);
  }
}

async function searchAllContacts(filters, properties, maxResults = 10000) {
  const all = [];
  let afterCursor;

  while (all.length < maxResults) {
    const body = {
      filterGroups: [{ filters }],
      properties,
      limit: SEARCH_LIMIT,
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
    };
    if (afterCursor) body.after = afterCursor;

    let data;
    try {
      data = await hubspotFetch("POST", "/crm/v3/objects/contacts/search", body);
    } catch (e) {
      // HubSpot 400 at 10k cursor limit — return what we have
      if (e.message && e.message.includes("400")) break;
      throw e;
    }
    all.push(...data.results);

    if (!data.paging?.next?.after) break;
    afterCursor = data.paging.next.after;
  }

  return all;
}

// ---------------------------------------------------------------------------
// ICP classification
// ---------------------------------------------------------------------------

function tokenize(jobtitle) {
  if (!jobtitle) return [];
  return jobtitle
    .toLowerCase()
    .split(/[\s,\/|&\-()]+/)
    .filter(Boolean);
}

function isIcp(jobtitle) {
  const words = tokenize(jobtitle);
  if (words.length === 0) return false;

  for (const token of ICP_SINGLE_TOKENS) {
    if (words.includes(token)) return true;
  }
  for (const compound of ICP_COMPOUND_TOKENS) {
    if (compound.every((t) => words.includes(t))) return true;
  }
  return false;
}

function hasActivity(props) {
  if (props.notes_last_updated) return true;
  if (parseInt(props.num_notes || "0", 10) > 0) return true;
  if (props.hs_sales_email_last_replied) return true;
  if (props.hs_last_sales_activity_timestamp) return true;
  if (parseInt(props.num_associated_deals || "0", 10) > 0) return true;
  if (props.hs_email_last_reply_date) return true;
  return false;
}

// ---------------------------------------------------------------------------
// CSV logging
// ---------------------------------------------------------------------------

const CSV_HEADER =
  "step,id,firstname,lastname,jobtitle,action,details,timestamp\n";

function escapeCsv(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function logCsv(logFile, step, contact, action, details) {
  const p = contact.properties || {};
  const fields = [
    step,
    contact.id,
    p.firstname,
    p.lastname,
    p.jobtitle,
    action,
    details,
    new Date().toISOString(),
  ];
  fs.appendFileSync(logFile, fields.map(escapeCsv).join(",") + "\n");
}

// ---------------------------------------------------------------------------
// Step 1: Lifecycle Stage Correction
// ---------------------------------------------------------------------------

async function stepLifecycleCorrection(opts) {
  console.log("\n========================================");
  console.log("STEP 1: Lifecycle Stage Correction");
  console.log("========================================\n");

  // 1a. Find all contacts with lifecycle stage = opportunity for this owner
  console.log("Finding contacts with lifecycle stage = opportunity...");
  const opportunityContacts = await searchAllContacts(
    [
      { propertyName: "hubspot_owner_id", operator: "EQ", value: opts.ownerId },
      { propertyName: "lifecyclestage", operator: "EQ", value: "opportunity" },
    ],
    ["firstname", "lastname", "email", "jobtitle", "lifecyclestage"]
  );
  console.log(`  Found ${opportunityContacts.length} opportunity contacts`);

  if (opportunityContacts.length === 0) {
    console.log("  No opportunity contacts to correct. Skipping.");
    return 0;
  }

  // 1b. Get all open deals in the active pipeline
  console.log("Fetching open deals from active pipeline...");
  const allDeals = [];
  let afterCursor;
  while (true) {
    const body = {
      filterGroups: [
        {
          filters: [
            { propertyName: "pipeline", operator: "EQ", value: ACTIVE_PIPELINE_ID },
          ],
        },
      ],
      properties: ["dealname", "dealstage"],
      limit: SEARCH_LIMIT,
    };
    if (afterCursor) body.after = afterCursor;
    const data = await hubspotFetch("POST", "/crm/v3/objects/deals/search", body);
    allDeals.push(...data.results);
    if (!data.paging?.next?.after) break;
    afterCursor = data.paging.next.after;
  }

  // Filter to open stages only
  const openDeals = allDeals.filter(
    (d) => !CLOSED_STAGES.includes(d.properties.dealstage)
  );
  console.log(`  Found ${openDeals.length} open deals`);

  // 1c. Get company IDs and domains for each open deal
  console.log("Fetching deal company associations and domains...");
  const dealCompanyIds = new Set();
  const dealCompanyDomains = new Set();

  for (const deal of openDeals) {
    try {
      const assocData = await hubspotFetch(
        "GET",
        `/crm/v4/objects/deals/${deal.id}/associations/companies`
      );
      for (const result of assocData.results || []) {
        const companyId = result.toObjectId;
        dealCompanyIds.add(String(companyId));

        // Fetch domain
        try {
          const company = await hubspotFetch(
            "GET",
            `/crm/v3/objects/companies/${companyId}?properties=domain`
          );
          const domain = (company.properties?.domain || "").trim().toLowerCase();
          if (domain) dealCompanyDomains.add(domain);
        } catch (e) {
          // skip
        }
      }
    } catch (e) {
      // skip
    }
    await sleep(50);
  }
  console.log(`  Deal companies: ${dealCompanyIds.size} IDs, ${dealCompanyDomains.size} domains`);

  // 1d. Check each opportunity contact against deal companies
  console.log("Cross-referencing contacts with deal companies...");
  const contactsToReset = [];

  for (const contact of opportunityContacts) {
    let matchesDeal = false;

    // Check company association
    try {
      const assocData = await hubspotFetch(
        "GET",
        `/crm/v4/objects/contacts/${contact.id}/associations/companies`
      );
      for (const result of assocData.results || []) {
        if (dealCompanyIds.has(String(result.toObjectId))) {
          matchesDeal = true;
          break;
        }
      }
    } catch (e) {
      // skip
    }

    // Check email domain
    if (!matchesDeal) {
      const email = (contact.properties?.email || "").trim().toLowerCase();
      if (email && email.includes("@")) {
        const domain = email.split("@")[1];
        if (dealCompanyDomains.has(domain)) {
          matchesDeal = true;
        }
      }
    }

    if (!matchesDeal) {
      contactsToReset.push(contact);
    }

    await sleep(50);
  }

  console.log(`  ${contactsToReset.length} contacts have no matching open deal → will reset to lead`);
  console.log(
    `  ${opportunityContacts.length - contactsToReset.length} contacts match an open deal → keeping as opportunity`
  );

  // 1e. Reset lifecycle stage: clear first, then set to lead
  if (contactsToReset.length > 0) {
    if (!opts.dryRun) {
      // Clear lifecycle stage
      const clearInputs = contactsToReset.map((c) => ({
        id: c.id,
        properties: { lifecyclestage: "" },
      }));
      await batchUpdateContacts(clearInputs);
      await sleep(500);

      // Set to lead
      const leadInputs = contactsToReset.map((c) => ({
        id: c.id,
        properties: { lifecyclestage: "lead" },
      }));
      await batchUpdateContacts(leadInputs);
    }

    for (const c of contactsToReset) {
      logCsv(opts.logFile, "lifecycle", c, "reset_to_lead", "opportunity → lead (no open deal)");
    }
    console.log(`  Updated ${contactsToReset.length} contacts: opportunity → lead`);
  }

  return contactsToReset.length;
}

// ---------------------------------------------------------------------------
// Step 2: ICP Cleanup
// ---------------------------------------------------------------------------

async function stepIcpCleanup(opts) {
  console.log("\n========================================");
  console.log("STEP 2: ICP Cleanup");
  console.log("========================================\n");

  const SEARCH_PROPERTIES = [
    "jobtitle",
    "firstname",
    "lastname",
    "hs_lead_status",
    "notes_last_updated",
    "num_notes",
    "hs_sales_email_last_replied",
    "hs_last_sales_activity_timestamp",
    "num_associated_deals",
    "hs_email_last_reply_date",
  ];

  let totalMoved = 0;
  let totalRequalifiedWorking = 0;
  let totalRequalifiedNew = 0;
  let totalKept = 0;
  let passNumber = 0;
  const seenIds = new Set(); // persist across passes to avoid double-counting

  while (true) {
    passNumber++;
    console.log(`--- Pass ${passNumber} ---`);

    // Paginate through contacts (up to 10k per pass due to HubSpot cap)
    let afterCursor;
    let moveBuffer = [];
    let requalifyBuffer = [];
    let passNonIcp = 0;
    let passIcp = 0;
    let passFetched = 0;

    while (true) {
      const body = {
        filterGroups: [
          { filters: [{ propertyName: "hubspot_owner_id", operator: "EQ", value: opts.ownerId }] },
        ],
        properties: SEARCH_PROPERTIES,
        limit: SEARCH_LIMIT,
        sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
      };
      if (afterCursor) body.after = afterCursor;

      let data;
      try {
        data = await hubspotFetch("POST", "/crm/v3/objects/contacts/search", body);
      } catch (e) {
        if (e.message && e.message.includes("400")) break;
        throw e;
      }

      passFetched += data.results.length;

      for (const contact of data.results) {
        if (seenIds.has(contact.id)) continue;
        seenIds.add(contact.id);

        const title = contact.properties?.jobtitle;

        if (isIcp(title)) {
          passIcp++;
          const status = (contact.properties?.hs_lead_status || "").toLowerCase();
          if (status === "not in icp" || status === "disqualified") {
            requalifyBuffer.push(contact);
          } else {
            logCsv(opts.logFile, "icp", contact, "kept", `ICP: ${title}`);
            totalKept++;
          }
        } else {
          passNonIcp++;
          moveBuffer.push(contact);

          // Flush move buffer in chunks to avoid memory buildup
          if (moveBuffer.length >= BATCH_SIZE) {
            const inputs = moveBuffer.map((c) => ({
              id: c.id,
              properties: {
                hubspot_owner_id: opts.targetOwnerId,
                hs_lead_status: "Not in ICP",
              },
            }));
            if (!opts.dryRun) {
              try { await batchUpdateContacts(inputs); } catch (err) {
                console.error(`  Batch FAILED (move): ${err.message}`);
              }
            }
            for (const c of moveBuffer) {
              logCsv(opts.logFile, "icp", c, "moved", `non-ICP: ${c.properties?.jobtitle || "(blank)"}`);
            }
            console.log(`  Moved batch of ${moveBuffer.length} non-ICP contacts`);
            moveBuffer = [];
          }
        }
      }

      if (!data.paging?.next?.after) break;
      afterCursor = data.paging.next.after;
    }

    // Flush remaining move buffer
    if (moveBuffer.length > 0) {
      const inputs = moveBuffer.map((c) => ({
        id: c.id,
        properties: {
          hubspot_owner_id: opts.targetOwnerId,
          hs_lead_status: "Not in ICP",
        },
      }));
      if (!opts.dryRun) {
        try { await batchUpdateContacts(inputs); } catch (err) {
          console.error(`  Batch FAILED (move): ${err.message}`);
        }
      }
      for (const c of moveBuffer) {
        logCsv(opts.logFile, "icp", c, "moved", `non-ICP: ${c.properties?.jobtitle || "(blank)"}`);
      }
      console.log(`  Moved ${moveBuffer.length} non-ICP contacts to target owner`);
    }

    // Requalify ICP contacts
    if (requalifyBuffer.length > 0) {
      const workingContacts = requalifyBuffer.filter((c) => hasActivity(c.properties || {}));
      const newContacts = requalifyBuffer.filter((c) => !hasActivity(c.properties || {}));

      if (workingContacts.length > 0) {
        const inputs = workingContacts.map((c) => ({
          id: c.id,
          properties: { hs_lead_status: "Has contacted but no response" },
        }));
        if (!opts.dryRun) await batchUpdateContacts(inputs);
        for (const c of workingContacts) {
          logCsv(opts.logFile, "icp", c, "requalified_working", c.properties?.jobtitle);
        }
        totalRequalifiedWorking += workingContacts.length;
        console.log(`  Requalified ${workingContacts.length} ICP contacts to Working`);
      }

      if (newContacts.length > 0) {
        const inputs = newContacts.map((c) => ({
          id: c.id,
          properties: { hs_lead_status: "No one has contacted them" },
        }));
        if (!opts.dryRun) await batchUpdateContacts(inputs);
        for (const c of newContacts) {
          logCsv(opts.logFile, "icp", c, "requalified_new", c.properties?.jobtitle);
        }
        totalRequalifiedNew += newContacts.length;
        console.log(`  Requalified ${newContacts.length} ICP contacts to New`);
      }
    }

    totalMoved += passNonIcp;

    console.log(`  Pass ${passNumber}: fetched=${passFetched}, ICP=${passIcp}, non-ICP=${passNonIcp}`);

    // If no non-ICP contacts were found this pass, we're done
    if (passNonIcp === 0) {
      console.log("  No more non-ICP contacts found. Done.");
      break;
    }

    // In dry-run mode, contacts aren't actually moved so subsequent passes
    // would find the same results. Run one pass only.
    if (opts.dryRun) {
      console.log("  Dry run — stopping after one pass.");
      break;
    }
  }

  console.log(`\n  ICP Summary: moved=${totalMoved}, requalified_working=${totalRequalifiedWorking}, requalified_new=${totalRequalifiedNew}, kept=${totalKept}`);
  return { totalMoved, totalRequalifiedWorking, totalRequalifiedNew, totalKept };
}

// ---------------------------------------------------------------------------
// Step 3: LinkedIn Enrichment
// ---------------------------------------------------------------------------

async function pdlMatchLinkedin(firstName, lastName, company, domain, email) {
  if (!PDL_KEY) return null;

  const params = new URLSearchParams();
  if (email) params.set("email", email);
  params.set("first_name", firstName);
  params.set("last_name", lastName);
  if (company) params.set("company", company);
  if (domain) params.set("website", domain);

  try {
    const res = await fetch(
      `https://api.peopledatalabs.com/v5/person/enrich?${params.toString()}`,
      {
        headers: { "X-Api-Key": PDL_KEY, Accept: "application/json" },
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.linkedin_url || null;
  } catch {
    return null;
  }
}

async function apolloMatchLinkedin(firstName, lastName, company, domain, email) {
  if (!APOLLO_KEY) return null;

  const payload = {
    first_name: firstName,
    last_name: lastName,
    organization_name: company,
  };
  if (domain) payload.domain = domain;
  if (email) payload.email = email;

  try {
    const res = await fetch("https://api.apollo.io/api/v1/people/match", {
      method: "POST",
      headers: {
        "X-Api-Key": APOLLO_KEY,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.person?.linkedin_url || null;
  } catch {
    return null;
  }
}

async function stepLinkedinEnrichment(opts) {
  console.log("\n========================================");
  console.log("STEP 3: LinkedIn Enrichment");
  console.log("========================================\n");

  if (!PDL_KEY && !APOLLO_KEY) {
    console.log("  No PDL_API or APOLLO_BULK_MATCH env vars set. Skipping enrichment.");
    return { found: 0, missed: 0 };
  }

  // Fetch remaining contacts for this owner
  console.log("Fetching owner's remaining contacts...");
  const contacts = await searchAllContacts(
    [{ propertyName: "hubspot_owner_id", operator: "EQ", value: opts.ownerId }],
    [
      "firstname",
      "lastname",
      "company",
      "jobtitle",
      "linkedin___profile",
      "hs_linkedin_url",
      "email",
      "domain",
    ]
  );
  console.log(`  Found ${contacts.length} contacts`);

  // Bidirectional sync linkedin___profile <-> hs_linkedin_url
  console.log("Syncing LinkedIn fields...");
  const syncUpdates = [];
  for (const c of contacts) {
    const p = c.properties || {};
    const custom = (p.linkedin___profile || "").trim();
    const hsUrl = (p.hs_linkedin_url || "").trim();

    if (custom && !hsUrl) {
      syncUpdates.push({ id: c.id, properties: { hs_linkedin_url: custom } });
      p.hs_linkedin_url = custom;
    } else if (hsUrl && !custom) {
      syncUpdates.push({ id: c.id, properties: { linkedin___profile: hsUrl } });
      p.linkedin___profile = hsUrl;
    }
  }

  if (syncUpdates.length > 0 && !opts.dryRun) {
    await batchUpdateContacts(syncUpdates);
  }
  console.log(`  Synced ${syncUpdates.length} contacts`);

  // Load previous misses
  const outputPath = path.resolve(`outputs/contact_enrichment/linkedin_enrich_${opts.ownerId}.json`);
  let previousMissIds = new Set();
  try {
    if (fs.existsSync(outputPath)) {
      const prev = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
      for (const m of prev.misses || []) {
        previousMissIds.add(String(m.id));
      }
    }
  } catch {
    // ignore
  }
  if (previousMissIds.size > 0) {
    console.log(`  Loaded ${previousMissIds.size} previous misses to skip`);
  }

  // Filter to those needing enrichment
  let toEnrich = [];
  let alreadyHave = 0;
  let skippedPrevious = 0;

  for (const c of contacts) {
    const custom = (c.properties?.linkedin___profile || "").trim();
    if (custom) {
      alreadyHave++;
    } else if (previousMissIds.has(c.id)) {
      skippedPrevious++;
    } else {
      toEnrich.push(c);
    }
  }

  console.log(`  ${alreadyHave} already have LinkedIn URL`);
  if (skippedPrevious > 0) console.log(`  ${skippedPrevious} skipped (previously missed)`);
  console.log(`  ${toEnrich.length} need enrichment`);

  if (opts.maxEnrich) {
    toEnrich = toEnrich.slice(0, opts.maxEnrich);
    console.log(`  Limiting to ${opts.maxEnrich} contacts`);
  }

  // Enrich — in dry-run mode, skip API calls to avoid burning credits
  const updates = [];
  const misses = [];
  let pdlFound = 0;
  let apolloFound = 0;

  if (opts.dryRun) {
    console.log(`\n  [DRY RUN] Skipping PDL/Apollo API calls to save credits`);
    console.log(`  ${toEnrich.length} contacts would be sent for enrichment`);
  } else {
    for (let i = 0; i < toEnrich.length; i++) {
      const c = toEnrich[i];
      const p = c.properties || {};
      const first = p.firstname || "";
      const last = p.lastname || "";
      const company = p.company || "";
      const domain = p.domain || "";
      const email = p.email || "";
      const title = p.jobtitle || "";

      if (!first && !last) continue;
      if (!company && !domain && !email) {
        misses.push({ id: c.id, name: `${first} ${last}`, company, title, reason: "no_company" });
        continue;
      }

      let linkedinUrl = null;

      // PDL first
      if (!opts.skipPdl && PDL_KEY) {
        linkedinUrl = await pdlMatchLinkedin(first, last, company, domain, email);
        if (linkedinUrl) {
          pdlFound++;
          console.log(`  [${i + 1}/${toEnrich.length}] PDL:    ${first} ${last} @ ${company} → ${linkedinUrl}`);
        }
      }

      // Apollo fallback
      if (!linkedinUrl && !opts.skipApollo && APOLLO_KEY) {
        linkedinUrl = await apolloMatchLinkedin(first, last, company, domain, email);
        if (linkedinUrl) {
          apolloFound++;
          console.log(`  [${i + 1}/${toEnrich.length}] Apollo: ${first} ${last} @ ${company} → ${linkedinUrl}`);
        }
      }

      if (linkedinUrl) {
        updates.push({
          id: c.id,
          properties: { linkedin___profile: linkedinUrl, hs_linkedin_url: linkedinUrl },
        });
        logCsv(opts.logFile, "enrichment", c, "linkedin_found", linkedinUrl);
      } else {
        console.log(`  [${i + 1}/${toEnrich.length}] MISS:   ${first} ${last} @ ${company} (${title})`);
        misses.push({ id: c.id, name: `${first} ${last}`, company, title, reason: "not_found" });
        logCsv(opts.logFile, "enrichment", c, "linkedin_miss", "not found");
      }

      await sleep(200);
    }
  }

  // Write updates to HubSpot
  if (updates.length > 0 && !opts.dryRun) {
    console.log(`\n  Updating ${updates.length} contacts in HubSpot...`);
    await batchUpdateContacts(updates);
  }

  // Save misses to JSON (skip in dry-run — found URLs aren't written either)
  if (!opts.dryRun) {
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const allMisses = [];
    const seenMissIds = new Set();
    // Keep previous misses
    try {
      if (fs.existsSync(outputPath)) {
        const prev = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
        for (const m of prev.misses || []) {
          if (m.id && !seenMissIds.has(String(m.id))) {
            allMisses.push(m);
            seenMissIds.add(String(m.id));
          }
        }
      }
    } catch {
      // ignore
    }
    for (const m of misses) {
      if (m.id && !seenMissIds.has(String(m.id))) {
        allMisses.push(m);
        seenMissIds.add(String(m.id));
      }
    }

    fs.writeFileSync(
      outputPath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          owner_id: opts.ownerId,
          stats: { pdl_found: pdlFound, apollo_found: apolloFound, misses: allMisses.length },
          misses: allMisses,
        },
        null,
        2
      )
    );
    console.log(`  Results saved to: ${outputPath}`);
  }

  console.log(`\n  Enrichment Summary: PDL=${pdlFound}, Apollo=${apolloFound}, misses=${misses.length}`);

  return { found: pdlFound + apolloFound, missed: misses.length };
}

// ---------------------------------------------------------------------------
// Step 4: Contact Type Tagging
// ---------------------------------------------------------------------------

async function stepContactTypeTagging(opts) {
  console.log("\n========================================");
  console.log("STEP 4: Contact Type Tagging");
  console.log("========================================\n");

  // Find contacts for this owner that don't already have contact_type set
  console.log("Finding contacts without contact_type...");
  const contacts = await searchAllContacts(
    [
      { propertyName: "hubspot_owner_id", operator: "EQ", value: opts.ownerId },
      { propertyName: "contact_type", operator: "NOT_HAS_PROPERTY" },
    ],
    ["firstname", "lastname", "jobtitle", "contact_type"]
  );
  console.log(`  Found ${contacts.length} contacts without contact_type`);

  if (contacts.length === 0) {
    console.log("  All contacts already tagged. Skipping.");
    return 0;
  }

  const inputs = contacts.map((c) => ({
    id: c.id,
    properties: { contact_type: "Prospective Customer" },
  }));

  if (!opts.dryRun) {
    await batchUpdateContacts(inputs);
  }

  for (const c of contacts) {
    logCsv(opts.logFile, "contact_type", c, "tagged_prospect", "contact_type → Prospect");
  }

  console.log(`  Tagged ${contacts.length} contacts as Prospect`);
  return contacts.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!TOKEN) {
    console.error("Error: HUBSPOT_ACCESS_TOKEN environment variable is not set");
    process.exit(1);
  }

  const opts = parseCliArgs();

  console.log("=== BDR Lead Pipeline ===");
  console.log(`Owner ID:         ${opts.ownerId}`);
  console.log(`Target Owner ID:  ${opts.targetOwnerId || "(n/a)"}`);
  console.log(`Dry run:          ${opts.dryRun}`);
  console.log(`Log file:         ${opts.logFile}`);
  console.log(`Steps:            ${[
    opts.skipLifecycle ? "" : "lifecycle",
    opts.skipIcp ? "" : "icp",
    opts.skipEnrichment ? "" : "enrichment",
    "contact_type",
  ]
    .filter(Boolean)
    .join(" → ")}`);

  // Initialize CSV log
  fs.writeFileSync(opts.logFile, CSV_HEADER);

  // Step 1: Lifecycle Stage Correction
  let lifecycleReset = 0;
  if (!opts.skipLifecycle) {
    lifecycleReset = await stepLifecycleCorrection(opts);
  }

  // Step 2: ICP Cleanup
  let icpResults = { totalMoved: 0, totalRequalifiedWorking: 0, totalRequalifiedNew: 0, totalKept: 0 };
  if (!opts.skipIcp) {
    icpResults = await stepIcpCleanup(opts);
  }

  // Step 3: LinkedIn Enrichment
  let enrichResults = { found: 0, missed: 0 };
  if (!opts.skipEnrichment) {
    enrichResults = await stepLinkedinEnrichment(opts);
  }

  // Step 4: Contact Type Tagging (always runs)
  const contactTypeTagged = await stepContactTypeTagging(opts);

  // Final summary
  console.log("\n========================================");
  console.log("FINAL SUMMARY");
  console.log("========================================");
  if (!opts.skipLifecycle) {
    console.log(`Lifecycle corrections:    ${lifecycleReset} contacts reset to lead`);
  }
  if (!opts.skipIcp) {
    console.log(`ICP moved (non-ICP):      ${icpResults.totalMoved}`);
    console.log(`ICP requalified Working:  ${icpResults.totalRequalifiedWorking}`);
    console.log(`ICP requalified New:      ${icpResults.totalRequalifiedNew}`);
    console.log(`ICP kept:                 ${icpResults.totalKept}`);
  }
  if (!opts.skipEnrichment) {
    console.log(`LinkedIn found:           ${enrichResults.found}`);
    console.log(`LinkedIn missed:          ${enrichResults.missed}`);
  }
  console.log(`Contact type tagged:      ${contactTypeTagged}`);
  console.log(`Audit log:                ${opts.logFile}`);
  if (opts.dryRun) {
    console.log("\n** DRY RUN — no changes were made **");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
