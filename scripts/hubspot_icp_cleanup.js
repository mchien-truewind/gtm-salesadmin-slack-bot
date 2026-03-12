#!/usr/bin/env node
// hubspot_icp_cleanup.js — Clean up HubSpot contacts by ICP criteria.
//
// Usage:
//   node hubspot_icp_cleanup.js \
//     --owner-id 84547075 \
//     --target-owner-id 87811681 \
//     [--created-after 2026-01-01] \
//     [--created-before 2027-01-01] \
//     [--dry-run] \
//     [--log-file ./cleanup.csv]
//
// Requires HUBSPOT_ACCESS_TOKEN env var.

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// ICP config — edit these to adjust matching criteria
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

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseCliArgs() {
  const args = process.argv.slice(2);
  const opts = {
    ownerId: null,
    targetOwnerId: null,
    createdAfter: null,
    createdBefore: null,
    dryRun: false,
    logFile: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--owner-id":
        opts.ownerId = args[++i];
        break;
      case "--target-owner-id":
        opts.targetOwnerId = args[++i];
        break;
      case "--created-after":
        opts.createdAfter = args[++i];
        break;
      case "--created-before":
        opts.createdBefore = args[++i];
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--log-file":
        opts.logFile = args[++i];
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
  if (!opts.targetOwnerId) {
    console.error("Error: --target-owner-id is required");
    process.exit(1);
  }

  if (!opts.logFile) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    opts.logFile = path.resolve(`icp_cleanup_${ts}.csv`);
  } else {
    opts.logFile = path.resolve(opts.logFile);
  }

  return opts;
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

// ---------------------------------------------------------------------------
// Activity detection
// ---------------------------------------------------------------------------

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
// HubSpot API helpers
// ---------------------------------------------------------------------------

const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;

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
      // Retry on 5xx
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

// ---------------------------------------------------------------------------
// Search contacts with pagination (single pass, up to 10k)
// ---------------------------------------------------------------------------

async function searchContactsPage(ownerId, createdAfter, createdBefore, afterCursor) {
  const filters = [
    { propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId },
  ];
  if (createdAfter) {
    filters.push({
      propertyName: "createdate",
      operator: "GTE",
      value: new Date(createdAfter).toISOString(),
    });
  }
  if (createdBefore) {
    filters.push({
      propertyName: "createdate",
      operator: "LT",
      value: new Date(createdBefore).toISOString(),
    });
  }

  const body = {
    filterGroups: [{ filters }],
    properties: SEARCH_PROPERTIES,
    limit: SEARCH_LIMIT,
    sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
  };
  if (afterCursor) body.after = afterCursor;

  return hubspotFetch("POST", "/crm/v3/objects/contacts/search", body);
}

// ---------------------------------------------------------------------------
// Batch update contacts
// ---------------------------------------------------------------------------

async function batchUpdateContacts(inputs) {
  return hubspotFetch("POST", "/crm/v3/objects/contacts/batch/update", { inputs });
}

// ---------------------------------------------------------------------------
// CSV log
// ---------------------------------------------------------------------------

const CSV_HEADER =
  "id,firstname,lastname,jobtitle,previous_owner,new_owner,previous_lead_status,new_lead_status,action,timestamp\n";

function escapeCsv(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(contact, prevOwner, newOwner, prevStatus, newStatus, action) {
  const p = contact.properties || {};
  const fields = [
    contact.id,
    p.firstname,
    p.lastname,
    p.jobtitle,
    prevOwner,
    newOwner,
    prevStatus,
    newStatus,
    action,
    new Date().toISOString(),
  ];
  return fields.map(escapeCsv).join(",") + "\n";
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

  console.log("=== HubSpot ICP Cleanup ===");
  console.log(`Source owner:       ${opts.ownerId}`);
  console.log(`Target owner:       ${opts.targetOwnerId}`);
  if (opts.createdAfter) console.log(`Created after:      ${opts.createdAfter}`);
  if (opts.createdBefore) console.log(`Created before:     ${opts.createdBefore}`);
  console.log(`Dry run:            ${opts.dryRun}`);
  console.log(`Log file:           ${opts.logFile}`);
  console.log("");

  // Initialize CSV log
  fs.writeFileSync(opts.logFile, CSV_HEADER);

  let totalMoved = 0;
  let totalRequalifiedWorking = 0;
  let totalRequalifiedNew = 0;
  let totalKept = 0;
  let passNumber = 0;

  // Outer loop: multiple passes to work around 10k search cap
  while (true) {
    passNumber++;
    console.log(`--- Pass ${passNumber} ---`);

    let afterCursor = undefined;
    let passGroup2Count = 0;
    let passGroup1Count = 0;
    let passFetched = 0;
    let batchNum = 0;
    const seenIds = new Set();

    // Buffers for batch updates
    let moveBuffer = []; // non-ICP contacts to reassign
    let requalifyBuffer = []; // ICP contacts that need lead status fix

    async function flushMoveBuffer() {
      if (moveBuffer.length === 0) return;
      batchNum++;
      const inputs = moveBuffer.map((c) => ({
        id: c.id,
        properties: {
          hubspot_owner_id: opts.targetOwnerId,
          hs_lead_status: "Not in ICP",
        },
      }));

      if (!opts.dryRun) {
        try {
          await batchUpdateContacts(inputs);
        } catch (err) {
          console.error(`  Batch ${batchNum} FAILED (move): ${err.message} — skipping ${inputs.length} contacts`);
          moveBuffer = [];
          return;
        }
      }

      // Log each contact
      for (const c of moveBuffer) {
        const row = csvRow(
          c,
          opts.ownerId,
          opts.targetOwnerId,
          c.properties?.hs_lead_status,
          "Not in ICP",
          "moved"
        );
        fs.appendFileSync(opts.logFile, row);
      }

      console.log(`  Batch ${batchNum}: moved ${moveBuffer.length} non-ICP contacts`);
      moveBuffer = [];
    }

    async function flushRequalifyBuffer() {
      if (requalifyBuffer.length === 0) return;

      // Split into working vs new
      const workingContacts = [];
      const newContacts = [];
      for (const c of requalifyBuffer) {
        if (hasActivity(c.properties || {})) {
          workingContacts.push(c);
        } else {
          newContacts.push(c);
        }
      }

      // Batch update working contacts
      if (workingContacts.length > 0) {
        const inputs = workingContacts.map((c) => ({
          id: c.id,
          properties: { hs_lead_status: "Has contacted but no response" },
        }));

        // Process in chunks of BATCH_SIZE
        for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
          const chunk = inputs.slice(i, i + BATCH_SIZE);
          if (!opts.dryRun) {
            try {
              await batchUpdateContacts(chunk);
            } catch (err) {
              console.error(`  Requalify batch FAILED (working): ${err.message} — skipping ${chunk.length} contacts`);
              continue;
            }
          }
        }

        for (const c of workingContacts) {
          const row = csvRow(
            c,
            opts.ownerId,
            opts.ownerId,
            c.properties?.hs_lead_status,
            "Has contacted but no response",
            "requalified"
          );
          fs.appendFileSync(opts.logFile, row);
        }
        totalRequalifiedWorking += workingContacts.length;
        console.log(`  Requalified ${workingContacts.length} ICP contacts to Working`);
      }

      // Batch update new contacts
      if (newContacts.length > 0) {
        const inputs = newContacts.map((c) => ({
          id: c.id,
          properties: { hs_lead_status: "No one has contacted them" },
        }));

        for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
          const chunk = inputs.slice(i, i + BATCH_SIZE);
          if (!opts.dryRun) {
            try {
              await batchUpdateContacts(chunk);
            } catch (err) {
              console.error(`  Requalify batch FAILED (new): ${err.message} — skipping ${chunk.length} contacts`);
              continue;
            }
          }
        }

        for (const c of newContacts) {
          const row = csvRow(
            c,
            opts.ownerId,
            opts.ownerId,
            c.properties?.hs_lead_status,
            "No one has contacted them",
            "requalified"
          );
          fs.appendFileSync(opts.logFile, row);
        }
        totalRequalifiedNew += newContacts.length;
        console.log(`  Requalified ${newContacts.length} ICP contacts to New`);
      }

      requalifyBuffer = [];
    }

    // Paginate through search results
    while (true) {
      const data = await searchContactsPage(
        opts.ownerId,
        opts.createdAfter,
        opts.createdBefore,
        afterCursor
      );

      passFetched += data.results.length;

      for (const contact of data.results) {
        if (seenIds.has(contact.id)) continue;
        seenIds.add(contact.id);

        const props = contact.properties || {};
        const title = props.jobtitle;

        if (isIcp(title)) {
          passGroup1Count++;

          // Check if ICP contact is currently Disqualified and needs requalification
          const status = (props.hs_lead_status || "").toLowerCase();
          if (status === "not in icp" || status === "disqualified") {
            requalifyBuffer.push(contact);
          } else {
            // ICP, not disqualified — keep as-is, just log
            const row = csvRow(
              contact,
              opts.ownerId,
              opts.ownerId,
              props.hs_lead_status,
              props.hs_lead_status,
              "kept"
            );
            fs.appendFileSync(opts.logFile, row);
            totalKept++;
          }
        } else {
          passGroup2Count++;
          moveBuffer.push(contact);

          if (moveBuffer.length >= BATCH_SIZE) {
            await flushMoveBuffer();
          }
        }
      }

      if (!data.paging?.next?.after) break;
      afterCursor = data.paging.next.after;
    }

    // Flush remaining buffers
    await flushMoveBuffer();
    await flushRequalifyBuffer();

    totalMoved += passGroup2Count;

    console.log(`  Pass ${passNumber} complete: fetched=${passFetched}, ICP=${passGroup1Count}, non-ICP=${passGroup2Count}`);

    // If no non-ICP contacts were found this pass, we're done
    if (passGroup2Count === 0) {
      console.log("  No more non-ICP contacts found. Done.");
      break;
    }
  }

  console.log("");
  console.log("=== Final Summary ===");
  console.log(`Total passes:                  ${passNumber}`);
  console.log(`Contacts moved (non-ICP):      ${totalMoved}`);
  console.log(`Contacts requalified (Working): ${totalRequalifiedWorking}`);
  console.log(`Contacts requalified (New):     ${totalRequalifiedNew}`);
  console.log(`Contacts kept (ICP, no change): ${totalKept}`);
  console.log(`Audit log:                     ${opts.logFile}`);
  if (opts.dryRun) {
    console.log("\n** DRY RUN — no changes were made **");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
