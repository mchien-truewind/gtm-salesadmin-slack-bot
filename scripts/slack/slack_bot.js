const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Load .env.local if it exists (local dev), otherwise use environment variables (Railway)
const envPath = path.resolve(__dirname, '../../.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)="?(.*?)"?\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk').default;
const { google } = require('googleapis');
const {
  DEFAULT_CHANNEL: INSTANTLY_POSITIVE_REPLY_DEFAULT_CHANNEL,
  handleInstantlyPositiveReplyWebhook,
} = require('./instantly_positive_reply_alert');
const {
  buildDiscoveryDigestConfig,
  dedupeDigestMeetings,
  dedupeGrainRecordings,
  findBestGrainRecordingForMeeting,
  formatGrainTranscriptText,
  getGrainRecordingId,
  getGrainRecordingStartMs,
  getGrainRecordingTitle,
  getGrainRecordingUrl,
  isLikelyGrainDiscoveryRecording,
  isLikelyHubSpotDiscoveryMeeting,
  normalizeDigestText,
  parseListItems,
} = require('./discovery_digest');

// ============================================================
// Google Sheets setup
// ============================================================
let tokenData;
const secretsPath = path.resolve(__dirname, '../../secrets/google-drive-token.json');
if (fs.existsSync(secretsPath)) {
  tokenData = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
} else {
  tokenData = {
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    token: process.env.GOOGLE_ACCESS_TOKEN,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  };
}
const oauth2Client = new google.auth.OAuth2(
  tokenData.client_id,
  tokenData.client_secret,
  'http://localhost'
);
oauth2Client.setCredentials({
  refresh_token: tokenData.refresh_token,
});
const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

// ============================================================
// HubSpot setup
// ============================================================
const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN;

async function hubspotRequest(endpoint, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint.startsWith('http') ? endpoint : `https://api.hubapi.com${endpoint}`);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${HUBSPOT_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ============================================================
// Tool definitions for Claude
// ============================================================
const TOOLS = [
  // --- Google Sheets tools ---
  {
    name: 'read_spreadsheet',
    description: 'Read data from a Google Spreadsheet. Use this to check existing content before adding rows.',
    input_schema: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string', description: 'The spreadsheet ID from the URL' },
        range: { type: 'string', description: 'A1 notation range, e.g. "Sheet1!A1:Z100"' },
      },
      required: ['spreadsheet_id', 'range'],
    },
  },
  {
    name: 'append_rows',
    description: 'Append rows to the bottom of a Google Spreadsheet. Each row is an array of cell values.',
    input_schema: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string', description: 'The spreadsheet ID from the URL' },
        range: { type: 'string', description: 'A1 notation for the target sheet/range, e.g. "Sheet1!A:Z"' },
        rows: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: 'Array of rows, each row is an array of cell values',
        },
      },
      required: ['spreadsheet_id', 'range', 'rows'],
    },
  },
  {
    name: 'update_cells',
    description: 'Update specific cells in a Google Spreadsheet.',
    input_schema: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string', description: 'The spreadsheet ID from the URL' },
        range: { type: 'string', description: 'A1 notation range to update, e.g. "Sheet1!A5:C5"' },
        values: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: 'Array of rows with cell values to write',
        },
      },
      required: ['spreadsheet_id', 'range', 'values'],
    },
  },
  // --- HubSpot tools ---
  {
    name: 'hubspot_search',
    description: 'Search HubSpot CRM objects (contacts, companies, deals, meetings). Returns matching records with requested properties.',
    input_schema: {
      type: 'object',
      properties: {
        object_type: { type: 'string', description: 'CRM object type: contacts, companies, deals, meetings, calls, emails, notes, tasks' },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              propertyName: { type: 'string' },
              operator: { type: 'string', description: 'EQ, NEQ, GT, GTE, LT, LTE, CONTAINS_TOKEN, etc.' },
              value: { type: 'string' },
            },
          },
          description: 'Array of filter objects',
        },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description: 'Properties to return, e.g. ["firstname", "lastname", "email"]',
        },
        sorts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              propertyName: { type: 'string' },
              direction: { type: 'string', description: 'ASCENDING or DESCENDING' },
            },
          },
          description: 'Optional sort order',
        },
        limit: { type: 'number', description: 'Max results (default 10, max 100)' },
      },
      required: ['object_type', 'properties'],
    },
  },
  {
    name: 'hubspot_get',
    description: 'Get a specific HubSpot CRM record by ID with requested properties.',
    input_schema: {
      type: 'object',
      properties: {
        object_type: { type: 'string', description: 'CRM object type: contacts, companies, deals, meetings' },
        object_id: { type: 'string', description: 'The record ID' },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description: 'Properties to return',
        },
      },
      required: ['object_type', 'object_id', 'properties'],
    },
  },
  {
    name: 'hubspot_list_owners',
    description: 'List all HubSpot owners (users/team members). Use this to map owner IDs to names.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  // --- HubSpot write tools ---
  {
    name: 'hubspot_create_contact',
    description: 'Create a new contact in HubSpot. Returns the new contact ID and properties.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Contact email address (required)' },
        firstname: { type: 'string', description: 'First name' },
        lastname: { type: 'string', description: 'Last name' },
        company: { type: 'string', description: 'Company name' },
        jobtitle: { type: 'string', description: 'Job title' },
        phone: { type: 'string', description: 'Phone number' },
        properties: {
          type: 'object',
          description: 'Additional properties as key-value pairs (e.g. lifecyclestage, contact_type, hubspot_owner_id, linkedin___profile, lead_source, enterprise_smb_industry)',
        },
      },
      required: ['email'],
    },
  },
  {
    name: 'hubspot_update_contact',
    description: 'Update an existing HubSpot contact by ID.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'The contact ID to update' },
        properties: {
          type: 'object',
          description: 'Properties to update as key-value pairs',
        },
      },
      required: ['contact_id', 'properties'],
    },
  },
  {
    name: 'hubspot_create_deal',
    description: 'Create a new deal in HubSpot. Active Pipeline ID is 105321581. Stages: MQL=1307720553, SQL=190380582, Full Product Demo=190380583, POC=190380586, Proposal=190380584, Won=1166230571, Closed/Lost=190380587.',
    input_schema: {
      type: 'object',
      properties: {
        dealname: { type: 'string', description: 'Deal name' },
        pipeline: { type: 'string', description: 'Pipeline ID (default: Active Pipeline 105321581)' },
        dealstage: { type: 'string', description: 'Stage ID' },
        amount: { type: 'number', description: 'Deal amount' },
        properties: {
          type: 'object',
          description: 'Additional properties (e.g. hubspot_owner_id, closedate)',
        },
      },
      required: ['dealname', 'dealstage'],
    },
  },
  {
    name: 'hubspot_update_deal',
    description: 'Update an existing HubSpot deal by ID.',
    input_schema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string', description: 'The deal ID to update' },
        properties: {
          type: 'object',
          description: 'Properties to update as key-value pairs',
        },
      },
      required: ['deal_id', 'properties'],
    },
  },
  {
    name: 'hubspot_create_association',
    description: 'Associate two HubSpot records. Common type IDs: contact_to_company=279, deal_to_contact=3, deal_to_company=341, contact_to_deal=4.',
    input_schema: {
      type: 'object',
      properties: {
        from_type: { type: 'string', description: 'Source object type (contacts, companies, deals)' },
        from_id: { type: 'string', description: 'Source object ID' },
        to_type: { type: 'string', description: 'Target object type (contacts, companies, deals)' },
        to_id: { type: 'string', description: 'Target object ID' },
        association_type_id: { type: 'number', description: 'Association type ID (e.g. 279 for contact_to_company)' },
      },
      required: ['from_type', 'from_id', 'to_type', 'to_id', 'association_type_id'],
    },
  },
  {
    name: 'hubspot_get_associations',
    description: 'Get associations for a HubSpot record (e.g. find all deals for a contact).',
    input_schema: {
      type: 'object',
      properties: {
        from_type: { type: 'string', description: 'Source object type (contacts, companies, deals)' },
        from_id: { type: 'string', description: 'Source object ID' },
        to_type: { type: 'string', description: 'Target object type (contacts, companies, deals)' },
      },
      required: ['from_type', 'from_id', 'to_type'],
    },
  },
  // --- Grain tools ---
  {
    name: 'grain_list_recordings',
    description: 'List recent Grain recordings with titles, dates, participants, IDs, and transcript links.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max recordings to return (default 10, max 50)' },
      },
    },
  },
  {
    name: 'grain_get_recording',
    description: 'Get full details of a Grain recording including summary, participants, transcript, and transcript link.',
    input_schema: {
      type: 'object',
      properties: {
        recording_id: { type: 'string', description: 'The Grain recording ID' },
      },
      required: ['recording_id'],
    },
  },
];

// ============================================================
// Tool execution
// ============================================================
async function executeTool(name, input) {
  try {
    // --- Google Sheets ---
    if (name === 'read_spreadsheet') {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: input.spreadsheet_id,
        range: input.range,
      });
      return JSON.stringify(res.data.values || []);
    }
    if (name === 'append_rows') {
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId: input.spreadsheet_id,
        range: input.range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: input.rows },
      });
      return `Appended ${res.data.updates.updatedRows} row(s)`;
    }
    if (name === 'update_cells') {
      const res = await sheets.spreadsheets.values.update({
        spreadsheetId: input.spreadsheet_id,
        range: input.range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: input.values },
      });
      return `Updated ${res.data.updatedCells} cell(s)`;
    }

    // --- HubSpot ---
    if (name === 'hubspot_search') {
      const body = {
        properties: input.properties,
        limit: input.limit || 10,
      };
      if (input.filters && input.filters.length > 0) {
        body.filterGroups = [{ filters: input.filters }];
      }
      if (input.sorts) body.sorts = input.sorts;
      const res = await hubspotRequest(`/crm/v3/objects/${input.object_type}/search`, 'POST', body);
      return JSON.stringify({ total: res.total, results: (res.results || []).map(r => ({ id: r.id, ...r.properties })) });
    }
    if (name === 'hubspot_get') {
      const props = input.properties.join(',');
      const res = await hubspotRequest(`/crm/v3/objects/${input.object_type}/${input.object_id}?properties=${props}`);
      return JSON.stringify({ id: res.id, ...res.properties });
    }
    if (name === 'hubspot_list_owners') {
      const res = await hubspotRequest('/crm/v3/owners/?limit=100');
      const owners = (res.results || []).map(o => ({ id: o.id, email: o.email, firstName: o.firstName, lastName: o.lastName }));
      return JSON.stringify(owners);
    }

    // --- HubSpot write ---
    if (name === 'hubspot_create_contact') {
      const props = { email: input.email };
      if (input.firstname) props.firstname = input.firstname;
      if (input.lastname) props.lastname = input.lastname;
      if (input.company) props.company = input.company;
      if (input.jobtitle) props.jobtitle = input.jobtitle;
      if (input.phone) props.phone = input.phone;
      if (input.properties) Object.assign(props, input.properties);
      const res = await hubspotRequest('/crm/v3/objects/contacts', 'POST', { properties: props });
      return JSON.stringify({ id: res.id, url: `https://app.hubspot.com/contacts/43974586/record/0-1/${res.id}`, ...res.properties });
    }
    if (name === 'hubspot_update_contact') {
      const res = await hubspotRequest(`/crm/v3/objects/contacts/${input.contact_id}`, 'PATCH', { properties: input.properties });
      return JSON.stringify({ id: res.id, ...res.properties });
    }
    if (name === 'hubspot_create_deal') {
      const props = { dealname: input.dealname, dealstage: input.dealstage, pipeline: input.pipeline || '105321581' };
      if (input.amount) props.amount = String(input.amount);
      if (input.properties) Object.assign(props, input.properties);
      const res = await hubspotRequest('/crm/v3/objects/deals', 'POST', { properties: props });
      return JSON.stringify({ id: res.id, url: `https://app.hubspot.com/contacts/43974586/record/0-3/${res.id}`, ...res.properties });
    }
    if (name === 'hubspot_update_deal') {
      const res = await hubspotRequest(`/crm/v3/objects/deals/${input.deal_id}`, 'PATCH', { properties: input.properties });
      return JSON.stringify({ id: res.id, ...res.properties });
    }
    if (name === 'hubspot_create_association') {
      const res = await hubspotRequest(
        `/crm/v4/objects/${input.from_type}/${input.from_id}/associations/${input.to_type}/${input.to_id}`,
        'PUT',
        [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: input.association_type_id }]
      );
      return JSON.stringify(res);
    }
    if (name === 'hubspot_get_associations') {
      const res = await hubspotRequest(`/crm/v4/objects/${input.from_type}/${input.from_id}/associations/${input.to_type}`);
      return JSON.stringify(res.results || []);
    }

    // --- Grain ---
    if (name === 'grain_list_recordings') {
      const limit = input.limit || 10;
      const res = await grainRequest(`/recordings?limit=${Math.min(limit, 50)}`);
      if (res.error) return `Error: ${res.error}`;
      const { items: recordings } = parseListItems(res);
      return JSON.stringify(recordings.map(recording => ({
        id: getGrainRecordingId(recording),
        title: getGrainRecordingTitle(recording),
        date: getGrainRecordingStartMs(recording) ? new Date(getGrainRecordingStartMs(recording)).toISOString() : '',
        participants: recording.participants || recording.attendees,
        transcript_url: getGrainRecordingUrl(recording),
      })));
    }
    if (name === 'grain_get_recording') {
      const detail = await fetchGrainRecordingDetail({ id: input.recording_id });
      if (detail.error) return `Error: ${detail.error}`;
      return JSON.stringify({
        ...detail,
        transcript_url: getGrainRecordingUrl(detail),
        transcript_text: formatGrainTranscriptText(detail),
      });
    }

    return `Unknown tool: ${name}`;
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// ============================================================
// Slack app setup
// ============================================================
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const INSTANTLY_POSITIVE_REPLY_CHANNEL = (
  process.env.INSTANTLY_POSITIVE_REPLY_SLACK_CHANNEL
  || INSTANTLY_POSITIVE_REPLY_DEFAULT_CHANNEL
);
const INSTANTLY_POSITIVE_REPLY_MENTION_USER_ID = (
  process.env.INSTANTLY_POSITIVE_REPLY_SLACK_MENTION_USER_ID
  || process.env.SLACK_USER_ID
  || ''
).trim();
const INSTANTLY_WEBHOOK_SECRET = (process.env.INSTANTLY_WEBHOOK_SECRET || '').trim();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PRIORITY_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1RSdbMzBer3O5-dMExLsn3I3ZCCL8vNYMKWs44Z36hnI/edit?gid=0#gid=0';
const PRIORITY_SHEET_ID = '1RSdbMzBer3O5-dMExLsn3I3ZCCL8vNYMKWs44Z36hnI';

function getSystemPrompt() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  return `You are Truewind's internal AI assistant in Slack. You have tools for Google Sheets, HubSpot CRM, and Grain meeting transcripts. You MUST use them when asked to take actions. NEVER say you can't do something -- you have the tools, use them.

Today's date is ${today}. Never use em dashes.

## CRITICAL: When someone says "add to prio list" or "add to priority list"
You MUST do the following steps using your tools. Do NOT just summarize -- actually write to the sheet:
1. Use read_spreadsheet to read the current sheet and understand the structure
2. Use append_rows to add the new row
3. Respond with the confirmation message below

## Priority List
- Spreadsheet ID: ${PRIORITY_SHEET_ID}
- URL: ${PRIORITY_SHEET_URL}

## Column structure (5 columns, this exact order)
1. **Category** -- Be specific. NEVER write just "Marketing". Use one of: Sales Enablement, Product Marketing, Social Media, Content Marketing, Brand, Events, Demand Gen, PR / Comms, Partnerships Marketing, Customer Marketing. If none fit, write a specific descriptor.
2. **Urgency** -- High, Medium, or Low
3. **Description** -- MAX 150 CHARACTERS. Focus on the DELIVERABLE/ACTION ITEM, not the backstory. Write it as a clear, concise task. Do NOT summarize the conversation. Example: "Develop plan to maximize ROI from AI Native Accounting Foundation sponsorship (co-marketing, speaking slots, content partnerships)."
4. **Date Added** -- Use thread_date from the Slack metadata (date of original thread post), NOT today
5. **Slack link** -- Build from metadata: https://truewindai.slack.com/archives/{channel_id}/p{thread_ts_with_dot_removed}

## Response format for priority list
After successfully appending, respond with EXACTLY this and nothing else:
:white_check_mark: Done. Priority list here: ${PRIORITY_SHEET_URL}

## HubSpot
You have access to HubSpot CRM. You can search contacts, companies, deals, meetings, and other objects. You can also look up owners (team members) by ID. Use hubspot_list_owners to map owner IDs to names when reporting.

Key owner IDs:
- Xavier Marco: 89305622
- Caitlyn Mathews: 84547075
- Mercedes Chien: 87811681

## Grain
You have access to Grain meeting transcripts. You can list recent recordings and get full details including summaries, participants, transcript text, and transcript links. Use this when asked about customer calls, meeting notes, or transcripts.

## General behavior
- Keep responses short and direct
- You receive full thread history. Use it to understand context.
- The Slack metadata (channel_id, thread_ts, thread_date) is appended to the last message.
- NEVER lie or fabricate results. If a tool call fails, show the actual error message. If you cannot do something, say exactly why (e.g. missing scope, token expired, tool not available). Do NOT say "done" or "created" unless you received a successful response with an ID back from the API.
- If a HubSpot record was just created and search can't find it, explain that HubSpot search indexing has a delay and provide the direct record ID/URL instead of claiming it doesn't exist.`;
}

// ============================================================
// Slack message handling
// ============================================================
function stripMention(text) {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

// Returns { messages, parentTs } where parentTs is the timestamp of the first/parent message
async function fetchThreadHistory(channel, threadTs, isThread) {
  const tokens = [process.env.SLACK_BOT_TOKEN, process.env.SLACK_USER_TOKEN].filter(Boolean);

  for (const token of tokens) {
    try {
      if (isThread) {
        const result = await app.client.conversations.replies({ token, channel, ts: threadTs });
        if (!result.ok || !result.messages) continue;
        console.log(`Fetched ${result.messages.length} thread messages (token=${token.slice(0,8)}...)`);

        const parentTs = result.messages[0].ts; // First message is always the parent
        const messages = [];
        for (const msg of result.messages) {
          const content = stripMention(msg.text || '');
          if (!content) continue;
          if (msg.bot_id) {
            messages.push({ role: 'assistant', content });
          } else {
            messages.push({ role: 'user', content });
          }
        }
        return { messages, parentTs };
      } else {
        const result = await app.client.conversations.history({ token, channel, limit: 20 });
        if (!result.ok || !result.messages) continue;
        console.log(`Fetched ${result.messages.length} channel messages (token=${token.slice(0,8)}...)`);

        const channelMsgs = result.messages.reverse();
        const messages = [];
        for (const msg of channelMsgs) {
          const content = stripMention(msg.text || '');
          if (!content) continue;
          if (msg.bot_id) {
            messages.push({ role: 'assistant', content });
          } else {
            messages.push({ role: 'user', content });
          }
        }
        return { messages, parentTs: null };
      }
    } catch (err) {
      console.error(`Error fetching history (token=${token.slice(0,8)}...): ${err.message}`);
      continue;
    }
  }
  console.error('All tokens failed to fetch history');
  return { messages: [], parentTs: null };
}

function mergeMessages(messages) {
  const merged = [];
  for (const msg of messages) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      merged[merged.length - 1].content += '\n' + msg.content;
    } else {
      merged.push({ ...msg });
    }
  }
  if (merged.length > 0 && merged[0].role !== 'user') merged.shift();
  if (merged.length > 0 && merged[merged.length - 1].role !== 'user') merged.pop();
  return merged;
}

async function handleMessage(text, threadTs, channel, isThread, say) {
  const cleanText = stripMention(text);
  if (!cleanText) return;

  console.log(`handleMessage: channel=${channel}, threadTs=${threadTs}, isThread=${isThread}, text="${cleanText}"`);

  const fetched = await fetchThreadHistory(channel, threadTs, isThread);
  let messages = fetched.messages;
  const parentTs = fetched.parentTs || threadTs;

  if (messages.length === 0) {
    messages = [{ role: 'user', content: cleanText }];
  }
  messages = mergeMessages(messages);
  if (messages.length === 0) {
    messages = [{ role: 'user', content: cleanText }];
  }

  // Use the actual parent message timestamp for the date, not the reply timestamp
  const threadDate = new Date(parseFloat(parentTs) * 1000).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const lastMsg = messages[messages.length - 1];
  lastMsg.content += `\n\n[Slack metadata: channel_id=${channel}, thread_ts=${parentTs}, thread_date=${threadDate}]`;

  // Helper to call Claude with retries on overload (529)
  async function callClaude(msgs) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 2048,
          system: getSystemPrompt(),
          tools: TOOLS,
          messages: msgs,
        });
      } catch (err) {
        if (err.status === 529 && attempt < 2) {
          console.log(`Overloaded, retrying in ${(attempt + 1) * 5}s...`);
          await new Promise((r) => setTimeout(r, (attempt + 1) * 5000));
          continue;
        }
        throw err;
      }
    }
  }

  try {
    // Agentic loop: keep calling Claude until it produces a final text response
    let response = await callClaude(messages);

    while (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
      const toolResults = [];

      for (const block of toolUseBlocks) {
        console.log(`Tool call: ${block.name}(${JSON.stringify(block.input)})`);
        const result = await executeTool(block.name, block.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        });
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });

      response = await callClaude(messages);
    }

    const textBlock = response.content.find((b) => b.type === 'text');
    const reply = textBlock ? textBlock.text : '(No response)';
    await say({ text: reply, thread_ts: threadTs });
  } catch (err) {
    console.error('Claude API error:', err.message);
    await say({ text: `My brain suddenly fried. :cry: Please try again in a few seconds.`, thread_ts: threadTs });
  }
}

// Respond to @mentions in channels
app.event('app_mention', async ({ event, say }) => {
  const isThread = !!event.thread_ts;
  const threadTs = event.thread_ts || event.ts;
  console.log(`app_mention: thread_ts=${event.thread_ts}, ts=${event.ts}, isThread=${isThread}`);
  await handleMessage(event.text, threadTs, event.channel, isThread, say);
});

// Respond to DMs
app.event('message', async ({ event, say }) => {
  if (event.channel_type !== 'im') return;
  if (event.bot_id || event.subtype) return;
  const isThread = !!event.thread_ts;
  const threadTs = event.thread_ts || event.ts;
  await handleMessage(event.text, threadTs, event.channel, isThread, say);
});

// ============================================================
// Daily Discovery Call Digest
// ============================================================
const DISCOVERY_DIGEST_CHANNEL = process.env.DISCOVERY_DIGEST_CHANNEL || 'slack-testing'; // #slack-testing
const GRAIN_API_TOKEN = process.env.GRAIN_API_TOKEN || process.env.GRAIN_ACCESS_TOKEN || process.env.GRAIN_WORKSPACE_TOKEN;
const GRAIN_API_BASE = process.env.GRAIN_API_BASE || 'https://api.grain.com/_/public-api';

async function grainRequest(endpoint) {
  if (!GRAIN_API_TOKEN) return { error: 'Grain not configured' };
  const url = endpoint.startsWith('http') ? endpoint : `${GRAIN_API_BASE.replace(/\/$/, '')}${endpoint}`;
  try {
    return await httpRequest(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${GRAIN_API_TOKEN}`,
        'Accept': 'application/json',
      },
    });
  } catch (err) {
    console.error(`Grain request error: ${err.message}`);
    return { error: err.message };
  }
}

async function searchHubSpotMeetingsForDigest(startOfDay, endOfDay) {
  const meetings = [];
  let after = '';
  const MAX_PAGES = 10;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'hs_meeting_start_time', operator: 'GTE', value: startOfDay.toISOString() },
          { propertyName: 'hs_meeting_start_time', operator: 'LT', value: endOfDay.toISOString() },
        ],
      }],
      properties: [
        'hs_meeting_title',
        'hs_meeting_start_time',
        'hs_meeting_end_time',
        'hs_meeting_body',
        'hubspot_owner_id',
      ],
      sorts: [{ propertyName: 'hs_meeting_start_time', direction: 'ASCENDING' }],
      limit: 100,
    };
    if (after) body.after = after;

    const res = await hubspotRequest('/crm/v3/objects/meetings/search', 'POST', body);
    const pageItems = res.results || [];
    meetings.push(...pageItems);
    after = res.paging?.next?.after || '';
    if (!after || pageItems.length === 0) break;
  }
  return meetings;
}

async function attachHubSpotContacts(meetings, config) {
  for (const meeting of meetings) {
    try {
      const assocRes = await hubspotRequest(`/crm/v4/objects/meetings/${meeting.id}/associations/contacts`);
      const contactIds = (assocRes.results || []).map(r => r.toObjectId);
      meeting._contactIds = contactIds;
      meeting._contacts = [];
      meeting._externalContacts = [];

      for (const cid of contactIds.slice(0, 5)) {
        const c = await hubspotRequest(`/crm/v3/objects/contacts/${cid}?properties=firstname,lastname,email,company,jobtitle`);
        if (!c.id) continue;
        meeting._contacts.push(c.properties);
        const email = normalizeDigestText(c.properties?.email);
        const domain = email.includes('@') ? email.split('@').pop() : '';
        if (email && !config.internalDomains.has(domain)) {
          meeting._externalContacts.push(c.properties);
        }
      }
    } catch (err) {
      console.error(`Failed to get contacts for meeting ${meeting.id}:`, err.message);
      meeting._contacts = [];
      meeting._externalContacts = [];
    }
  }
}

async function fetchGrainRecordingsForDay(startOfDay, endOfDay) {
  if (!GRAIN_API_TOKEN) {
    throw new Error('Missing Grain API token. Set GRAIN_API_TOKEN, GRAIN_ACCESS_TOKEN, or GRAIN_WORKSPACE_TOKEN.');
  }

  const recordings = [];
  let cursor = '';
  const maxPages = Number(process.env.GRAIN_DIGEST_MAX_PAGES || 20);
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ limit: process.env.GRAIN_DIGEST_PAGE_SIZE || '100' });
    if (cursor && !cursor.startsWith('http')) params.set('cursor', cursor);
    const endpoint = cursor && cursor.startsWith('http') ? cursor : `/recordings?${params}`;
    const payload = await grainRequest(endpoint);
    if (payload?.error) throw new Error(`Grain recordings API returned an error: ${payload.error}`);

    const { items, cursor: nextCursor, hasMore } = parseListItems(payload);
    recordings.push(...items);
    if (!hasMore || !nextCursor || items.length === 0) break;
    cursor = nextCursor;
  }

  return dedupeGrainRecordings(recordings).filter(recording => {
    const startMs = getGrainRecordingStartMs(recording);
    return startMs >= startOfDay.getTime() && startMs < endOfDay.getTime();
  });
}

async function fetchGrainRecordingDetail(recording) {
  const id = getGrainRecordingId(recording);
  if (!id) return recording;

  const detailEndpoints = [
    `/recordings/${encodeURIComponent(id)}?include=transcript,summary,participants`,
    `/recordings/${encodeURIComponent(id)}`,
    `/recordings/${encodeURIComponent(id)}/transcript?format=json`,
    `/recordings/${encodeURIComponent(id)}/transcript`,
  ];

  let merged = { ...recording };
  for (const endpoint of detailEndpoints) {
    const payload = await grainRequest(endpoint);
    if (!payload || payload.error) continue;
    if (Array.isArray(payload) || typeof payload === 'string') {
      merged.transcript = payload;
    } else if (payload.transcript || payload.transcript_text || payload.text || payload.id) {
      merged = { ...merged, ...payload };
    }
    if (formatGrainTranscriptText(merged)) break;
  }
  return merged;
}

async function applyGrainRecordingToMeeting(meeting, recording) {
  const detail = await fetchGrainRecordingDetail(recording);
  meeting._grainId = getGrainRecordingId(detail) || getGrainRecordingId(recording);
  meeting._transcriptUrl = getGrainRecordingUrl(detail) || getGrainRecordingUrl(recording);
  meeting._transcript = formatGrainTranscriptText(detail);
  meeting._summary = typeof detail.summary === 'object' ? detail.summary.overview : detail.summary;
  meeting._grainRecording = detail;
  return meeting;
}

async function resolveExternalGrainContacts(recording, config) {
  const contacts = [];
  const participants = recording?.participants || recording?.attendees || [];
  const externalParticipants = participants.filter(p => {
    const email = normalizeDigestText(p.email || p.email_address);
    const domain = email.includes('@') ? email.split('@').pop() : '';
    return email && !config.internalDomains.has(domain);
  });

  for (const participant of externalParticipants.slice(0, 3)) {
    const email = participant.email || participant.email_address;
    try {
      const searchRes = await hubspotRequest('/crm/v3/objects/contacts/search', 'POST', {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        properties: ['firstname', 'lastname', 'email', 'company', 'jobtitle'],
        limit: 1,
      });
      if (searchRes.results?.length > 0) {
        contacts.push(searchRes.results[0].properties);
        continue;
      }
    } catch (err) {
      console.error(`Failed to resolve Grain participant ${email} in HubSpot:`, err.message);
    }

    const nameParts = String(participant.name || participant.full_name || '').trim().split(/\s+/);
    contacts.push({
      firstname: nameParts[0] || '',
      lastname: nameParts.slice(1).join(' '),
      email,
      company: participant.company || '',
      jobtitle: participant.title || participant.job_title || '',
    });
  }

  return contacts;
}

function getPacificDayRange(now = new Date()) {
  const labelFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const labelParts = Object.fromEntries(labelFormatter.formatToParts(now).map(part => [part.type, part.value]));
  const dateLabel = `${labelParts.weekday}, ${labelParts.month} ${Number(labelParts.day)}, ${labelParts.year}`;

  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(dateParts.map(part => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month) - 1;
  const day = Number(values.day);
  const ptLocal = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const utcLocal = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = ptLocal.getTime() - utcLocal.getTime();

  return {
    startOfDay: new Date(Date.UTC(year, month, day, 0, 0, 0) - offsetMs),
    endOfDay: new Date(Date.UTC(year, month, day + 1, 0, 0, 0) - offsetMs),
    dateLabel,
  };
}

async function runDiscoveryDigest(channelOverride) {
  const channel = channelOverride || DISCOVERY_DIGEST_CHANNEL;
  console.log('Running discovery call digest...');

  const config = buildDiscoveryDigestConfig(process.env);
  const { startOfDay, endOfDay, dateLabel } = getPacificDayRange();

  try {
    const allMeetings = await searchHubSpotMeetingsForDigest(startOfDay, endOfDay);
    await attachHubSpotContacts(allMeetings, config);
    const hubspotDiscoveryMeetings = allMeetings.filter(meeting => isLikelyHubSpotDiscoveryMeeting(meeting, config));
    const canceled = hubspotDiscoveryMeetings.filter(m => normalizeDigestText(m.properties.hs_meeting_title).startsWith('canceled:'));
    const scheduled = hubspotDiscoveryMeetings.filter(m => !normalizeDigestText(m.properties.hs_meeting_title).startsWith('canceled:'));

    const grainToday = await fetchGrainRecordingsForDay(startOfDay, endOfDay);
    console.log(`Grain: fetched ${grainToday.length} recordings for ${startOfDay.toISOString()} to ${endOfDay.toISOString()}`);

    const matchedGrainIds = new Set();
    for (const meeting of scheduled) {
      const matched = findBestGrainRecordingForMeeting(meeting, grainToday, config, matchedGrainIds);
      if (!matched) continue;
      await applyGrainRecordingToMeeting(meeting, matched);
      if (meeting._grainId) matchedGrainIds.add(meeting._grainId);
    }

    const unmatchedGrainRecordings = grainToday.filter(recording => {
      const id = getGrainRecordingId(recording);
      return !id || !matchedGrainIds.has(id);
    });
    for (const recording of unmatchedGrainRecordings) {
      if (!isLikelyGrainDiscoveryRecording(recording, config)) continue;
      const detail = await fetchGrainRecordingDetail(recording);
      if (!isLikelyGrainDiscoveryRecording(detail, config)) continue;

      const contacts = await resolveExternalGrainContacts(detail, config);
      const startMs = getGrainRecordingStartMs(detail) || getGrainRecordingStartMs(recording);
      const fallbackMeeting = {
        id: `grain_${getGrainRecordingId(detail) || getGrainRecordingId(recording)}`,
        properties: {
          hs_meeting_title: getGrainRecordingTitle(detail) || getGrainRecordingTitle(recording) || 'Unknown',
          hs_meeting_start_time: startMs ? new Date(startMs).toISOString() : '',
        },
        _contacts: contacts,
        _externalContacts: contacts,
        _fromGrainFallback: true,
      };

      await applyGrainRecordingToMeeting(fallbackMeeting, detail);
      if (fallbackMeeting._grainId) matchedGrainIds.add(fallbackMeeting._grainId);
      scheduled.push(fallbackMeeting);
    }

    const uniqueCanceled = dedupeDigestMeetings(canceled);
    const uniqueScheduled = dedupeDigestMeetings(scheduled);

    // Completed means Grain has a matched recording with transcript or summary content.
    const hasContent = (m) => m._grainId && (m._summary || m._transcript);
    const completed = uniqueScheduled.filter(m => hasContent(m));
    const noShows = uniqueScheduled.filter(m => !hasContent(m));

    if (uniqueScheduled.length === 0 && uniqueCanceled.length === 0) {
      await app.client.chat.postMessage({
        token: process.env.SLACK_BOT_TOKEN,
        channel,
        text: `*Discovery Call Digest -- ${dateLabel}*\n\nNo discovery calls were scheduled yesterday.`,
      });
      console.log('No discovery calls yesterday.');
      return;
    }

    // Use Claude to extract takeaways and quotes from completed calls.
    for (const meeting of completed) {
      let transcriptText = String(meeting._transcript || '').slice(0, 5000);
      if (!transcriptText && meeting._summary) {
        transcriptText = String(meeting._summary);
      }
      if (!transcriptText) continue;

      try {
        const claudeRes = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 500,
          system: `You extract key takeaways and pain point quotes from sales discovery call transcripts. Be concise. Never use em dashes.`,
          messages: [{
            role: 'user',
            content: `Extract from this discovery call transcript:
1. One-line takeaway (what the prospect needs/their situation)
2. One direct quote that illustrates their pain point (exact words from the transcript, with the speaker's name)

Transcript:
${transcriptText.slice(0, 4000)}

Reply in this exact format:
TAKEAWAY: ...
QUOTE: "..." -- [Speaker Name]`,
          }],
        });
        const text = claudeRes.content.find(b => b.type === 'text')?.text || '';
        const takeawayMatch = text.match(/TAKEAWAY:\s*(.+)/);
        const quoteMatch = text.match(/QUOTE:\s*(.+)/);
        meeting._takeaway = takeawayMatch ? takeawayMatch[1].trim() : null;
        meeting._quote = quoteMatch ? quoteMatch[1].trim() : null;
      } catch (err) {
        console.error(`Claude extraction failed for meeting ${meeting.id}:`, err.message);
      }
    }

    // 7. Format and post
    let msg = `*Discovery Call Digest -- ${dateLabel}*\n\n`;
    msg += `Scheduled: ${uniqueScheduled.length + uniqueCanceled.length}\n`;
    msg += `Completed: ${completed.length}\n`;
    msg += `No-shows: ${noShows.length}`;
    if (noShows.length > 0) {
      const noShowNames = noShows.map(m => {
        const ext = (m._externalContacts || [])[0];
        const name = ext ? `${ext.firstname || ''} ${ext.lastname || ''}`.trim() : (m.properties.hs_meeting_title || 'Unknown');
        const co = ext?.company || '';
        return co ? `${name} (${co})` : name;
      });
      msg += ` -- ${noShowNames.join(', ')}`;
    }
    msg += `\nCanceled: ${uniqueCanceled.length}`;
    if (uniqueCanceled.length > 0) {
      const cancelNames = uniqueCanceled.map(m => (m.properties.hs_meeting_title || '').replace('Canceled: ', '').replace(' and Sarah Elix', ''));
      msg += ` -- ${cancelNames.join(', ')}`;
    }
    msg += '\n';

    for (const meeting of completed) {
      const ext = (meeting._externalContacts || [])[0];
      const name = ext ? `${ext.firstname || ''} ${ext.lastname || ''}`.trim() : 'Unknown';
      const title = ext?.jobtitle || '';
      const company = ext?.company || '';
      const header = [name, title, company].filter(Boolean).join(' | ');

      msg += `\n---\n*${header}*\n`;
      if (meeting._takeaway) msg += `Takeaway: ${meeting._takeaway}\n`;
      if (meeting._quote) msg += `Pain quote: ${meeting._quote}\n`;
      if (meeting._transcriptUrl) msg += `Transcript: ${meeting._transcriptUrl}\n`;
    }

    await app.client.chat.postMessage({
      token: process.env.SLACK_BOT_TOKEN,
      channel,
      text: msg,
    });
    console.log('Discovery digest posted.');
  } catch (err) {
    console.error('Discovery digest error:', err.message);
    await app.client.chat.postMessage({
      token: process.env.SLACK_BOT_TOKEN,
      channel,
      text: `Discovery digest failed: ${err.message}`,
    });
  }
}

// Schedule weekdays at 4 PM PST (00:00 UTC next day during PST, 23:00 UTC during PDT)
function scheduleDiscoveryDigest() {
  const TARGET_HOUR_UTC = 0; // 4 PM PST = 00:00 UTC next day
  function msUntilNext() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(TARGET_HOUR_UTC, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    // Skip weekends (0=Sun, 6=Sat) -- digest runs Mon-Fri for today's calls
    while (next.getUTCDay() === 0 || next.getUTCDay() === 6) {
      next.setDate(next.getDate() + 1);
    }
    return next - now;
  }
  // Check if today's run was missed (e.g. service restarted after target time).
  // "Today" in PT: if it's past 4 PM PST on a weekday, run immediately.
  const now = new Date();
  const ptHour = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const ptDay = ptHour.getDay(); // 0=Sun, 6=Sat
  const isWeekday = ptDay >= 1 && ptDay <= 5;
  const isPastTarget = ptHour.getHours() >= 16; // 4 PM PT
  if (isWeekday && isPastTarget) {
    console.log(`  Discovery digest: missed today's run, triggering now`);
    runDiscoveryDigest();
  }
  function run() {
    runDiscoveryDigest();
    setTimeout(run, msUntilNext());
  }
  setTimeout(run, msUntilNext());
  const nextRun = new Date(Date.now() + msUntilNext());
  console.log(`  Discovery digest scheduled, next run: ${nextRun.toISOString()}`);
}

// ============================================================
// Daily meetings-booked progress post
// ============================================================
const PROGRESS_TARGET_CHANNEL = process.env.LEAD_REPORT_TARGET_CHANNEL || 'gtm-general';
const PROGRESS_INBOUND_CHANNEL = process.env.LEAD_REPORT_INBOUND_CHANNEL || 'leads';
const PROGRESS_OUTBOUND_CHANNEL = process.env.LEAD_REPORT_OUTBOUND_CHANNEL || 'gtm-outbound';
const PROGRESS_INBOUND_PHRASE = process.env.LEAD_REPORT_INBOUND_PHRASE || 'Booked Calendly Meeting';
const PROGRESS_OUTBOUND_PHRASE = process.env.LEAD_REPORT_OUTBOUND_PHRASE || 'New Meeting';
const PROGRESS_WEEKLY_GOAL = parseFloat(process.env.LEAD_REPORT_WEEKLY_GOAL || '17.5');
const PROGRESS_EXCLUDE_PATTERNS = ['truewind', 'test'];
const PROGRESS_TIMEZONE = 'America/Los_Angeles';
const PROGRESS_TARGET_HOUR = 18;
const PROGRESS_TARGET_MINUTE = 7;
const PACIFIC_WEEKDAY_INDEX = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};
const PACIFIC_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: PROGRESS_TIMEZONE,
  weekday: 'short',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  hourCycle: 'h23',
});

async function resolveChannelId(name) {
  let cursor;
  do {
    const res = await app.client.conversations.list({
      token: process.env.SLACK_BOT_TOKEN,
      exclude_archived: true,
      types: 'public_channel',
      limit: 1000,
      cursor: cursor || undefined,
    });
    const ch = (res.channels || []).find(c => c.name === name);
    if (ch) return ch.id;
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return null;
}

async function collectMatchingTimestamps(channelId, phrase, oldest, latest, excludePatterns) {
  const timestamps = [];
  const skipLower = excludePatterns.map(p => p.toLowerCase());
  let cursor;
  do {
    const res = await app.client.conversations.history({
      token: process.env.SLACK_BOT_TOKEN,
      channel: channelId,
      oldest: String(oldest),
      latest: String(latest),
      inclusive: true,
      limit: 200,
      cursor: cursor || undefined,
    });
    for (const msg of res.messages || []) {
      const text = msg.text || '';
      if (!text.includes(phrase)) continue;
      const lower = text.toLowerCase();
      if (skipLower.some(p => lower.includes(p))) continue;
      timestamps.push(parseFloat(msg.ts));
    }
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return timestamps;
}

function fmtNum(v) {
  const s = v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return s || '0';
}

function getPacificParts(date = new Date()) {
  const parsed = {};
  for (const part of PACIFIC_DATE_FORMATTER.formatToParts(date)) {
    if (part.type !== 'literal') parsed[part.type] = part.value;
  }
  return {
    year: Number(parsed.year),
    month: Number(parsed.month),
    day: Number(parsed.day),
    hour: Number(parsed.hour),
    minute: Number(parsed.minute),
    second: Number(parsed.second),
    weekdayIndex: PACIFIC_WEEKDAY_INDEX[parsed.weekday],
  };
}

function shiftPacificDate(parts, dayDelta) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  shifted.setUTCDate(shifted.getUTCDate() + dayDelta);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function pacificLocalToUtcDate(year, month, day, hour = 0, minute = 0, second = 0) {
  for (const utcOffsetHours of [7, 8]) {
    const candidate = new Date(Date.UTC(year, month - 1, day, hour + utcOffsetHours, minute, second));
    const parts = getPacificParts(candidate);
    if (
      parts.year === year
      && parts.month === month
      && parts.day === day
      && parts.hour === hour
      && parts.minute === minute
      && parts.second === second
    ) {
      return candidate;
    }
  }
  throw new Error(`Unable to resolve Pacific local time ${year}-${month}-${day} ${hour}:${minute}:${second}`);
}

function formatPacificDateLabel(parts) {
  return `${parts.month}/${parts.day}/${String(parts.year).slice(-2)}`;
}

function getDailyProgressWindow(now = new Date()) {
  const nowPacific = getPacificParts(now);
  const todayStartUtc = pacificLocalToUtcDate(nowPacific.year, nowPacific.month, nowPacific.day, 0, 0, 0);
  const daysSinceMonday = (nowPacific.weekdayIndex + 6) % 7;
  const weekStartDate = shiftPacificDate(nowPacific, -daysSinceMonday);
  const weekStartUtc = pacificLocalToUtcDate(weekStartDate.year, weekStartDate.month, weekStartDate.day, 0, 0, 0);
  const targetRunUtc = pacificLocalToUtcDate(
    nowPacific.year,
    nowPacific.month,
    nowPacific.day,
    PROGRESS_TARGET_HOUR,
    PROGRESS_TARGET_MINUTE,
    0,
  );
  return {
    latest: now.getTime() / 1000,
    now,
    nowPacific,
    targetRunUtc,
    todayOldest: todayStartUtc.getTime() / 1000,
    weekOldest: weekStartUtc.getTime() / 1000,
  };
}

function getNextDailyProgressRun(referenceDate = new Date()) {
  const currentPacific = getPacificParts(referenceDate);
  let nextDate = {
    year: currentPacific.year,
    month: currentPacific.month,
    day: currentPacific.day,
  };
  let nextRunUtc = pacificLocalToUtcDate(
    nextDate.year,
    nextDate.month,
    nextDate.day,
    PROGRESS_TARGET_HOUR,
    PROGRESS_TARGET_MINUTE,
    0,
  );

  if (nextRunUtc <= referenceDate) {
    nextDate = shiftPacificDate(nextDate, 1);
    nextRunUtc = pacificLocalToUtcDate(
      nextDate.year,
      nextDate.month,
      nextDate.day,
      PROGRESS_TARGET_HOUR,
      PROGRESS_TARGET_MINUTE,
      0,
    );
  }

  return { nextDate, nextRunUtc };
}

async function runDailyProgress(channelOverride, options = {}) {
  const force = Boolean(options.force);
  const targetName = channelOverride || PROGRESS_TARGET_CHANNEL;
  try {
    const [inboundId, outboundId, targetId] = await Promise.all([
      resolveChannelId(PROGRESS_INBOUND_CHANNEL),
      resolveChannelId(PROGRESS_OUTBOUND_CHANNEL),
      resolveChannelId(targetName),
    ]);
    if (!inboundId) throw new Error(`Channel not found: #${PROGRESS_INBOUND_CHANNEL}`);
    if (!outboundId) throw new Error(`Channel not found: #${PROGRESS_OUTBOUND_CHANNEL}`);
    if (!targetId) throw new Error(`Channel not found: #${targetName}`);

    const { latest, now, nowPacific, targetRunUtc, todayOldest, weekOldest } = getDailyProgressWindow();
    const dateLabel = formatPacificDateLabel(nowPacific);

    if (!force && now < targetRunUtc) {
      console.log(`Daily progress: deferred until ${targetRunUtc.toISOString()} for ${dateLabel} PT`);
      return;
    }

    const [inboundTs, outboundTs] = await Promise.all([
      collectMatchingTimestamps(inboundId, PROGRESS_INBOUND_PHRASE, weekOldest, latest, PROGRESS_EXCLUDE_PATTERNS),
      collectMatchingTimestamps(outboundId, PROGRESS_OUTBOUND_PHRASE, weekOldest, latest, []),
    ]);

    const weekInbound = inboundTs.length;
    const weekOutbound = outboundTs.length;
    const todayInbound = inboundTs.filter(ts => ts >= todayOldest).length;
    const todayOutbound = outboundTs.filter(ts => ts >= todayOldest).length;
    const todayTotal = todayInbound + todayOutbound;
    const weekTotal = weekInbound + weekOutbound;
    const remaining = Math.max(PROGRESS_WEEKLY_GOAL - weekTotal, 0);

    const dupCheck = await app.client.conversations.history({
      token: process.env.SLACK_BOT_TOKEN,
      channel: targetId,
      oldest: String(todayOldest),
      latest: String(latest),
      inclusive: true,
      limit: 50,
    });
    const prefix = `Today ${dateLabel}`;
    const alreadyPosted = (dupCheck.messages || []).some(m => (m.text || '').startsWith(prefix));
    if (alreadyPosted) {
      console.log(`Daily progress: skipped duplicate for ${dateLabel} in #${targetName}`);
      return;
    }

    const text = `Today ${dateLabel}\n`
      + `Inbound: ${todayInbound}\n`
      + `Outbound: ${todayOutbound}\n`
      + `Total: ${todayTotal}\n`
      + `\n\n`
      + `This week so far\n`
      + `Inbound: ${weekInbound}\n`
      + `Outbound: ${weekOutbound}\n`
      + `Total: ${weekTotal}\n`
      + `\n`
      + `Weekly Goal: ${fmtNum(PROGRESS_WEEKLY_GOAL)}\n`
      + `:star2: How many more do we need? ${fmtNum(remaining)}`;

    await app.client.chat.postMessage({
      token: process.env.SLACK_BOT_TOKEN,
      channel: targetId,
      text,
    });
    console.log(`Daily progress: posted to #${targetName} (today=${todayInbound}+${todayOutbound}, week=${weekInbound}+${weekOutbound})`);
  } catch (err) {
    console.error('Daily progress error:', err.message);
  }
}

function scheduleDailyProgress() {
  const scheduleNext = () => {
    const { nextDate, nextRunUtc } = getNextDailyProgressRun();
    const delayMs = Math.max(nextRunUtc.getTime() - Date.now(), 1000);
    setTimeout(async () => {
      await runDailyProgress();
      scheduleNext();
    }, delayMs);
    console.log(
      `  Daily progress scheduled, next run: ${nextRunUtc.toISOString()} `
      + `(${nextDate.month}/${nextDate.day}/${String(nextDate.year).slice(-2)} `
      + `${String(PROGRESS_TARGET_HOUR).padStart(2, '0')}:${String(PROGRESS_TARGET_MINUTE).padStart(2, '0')} PT)`,
    );
  };

  runDailyProgress().catch(err => {
    console.error('Daily progress startup check error:', err.message);
  });
  scheduleNext();
}

(async () => {
  await app.start();
  console.log('Slack bot is running in socket mode');
  console.log(`  Google Sheets: ready`);
  console.log(`  HubSpot: ${HUBSPOT_TOKEN ? 'ready' : 'NOT CONFIGURED'}`);
  console.log(`  Grain: ${GRAIN_API_TOKEN ? 'ready' : 'NOT CONFIGURED'}`);

  // Schedule daily discovery digest
  scheduleDiscoveryDigest();

  // Schedule daily meetings-booked progress
  scheduleDailyProgress();

  // Health check server for Railway (needs a port to know the service is alive)
  const PORT = process.env.PORT || 3000;
  http.createServer(async (req, res) => {
    if (req.url.split('?')[0] === '/webhooks/instantly/positive-reply') {
      try {
        await handleInstantlyPositiveReplyWebhook(req, res, {
          slackClient: app.client,
          slackToken: process.env.SLACK_BOT_TOKEN,
          channel: INSTANTLY_POSITIVE_REPLY_CHANNEL,
          mentionUserId: INSTANTLY_POSITIVE_REPLY_MENTION_USER_ID,
          webhookSecret: INSTANTLY_WEBHOOK_SECRET,
          logger: console,
        });
      } catch (err) {
        console.error('Instantly positive reply webhook failed:', err.message);
        res.writeHead(500);
        res.end('webhook_failed');
      }
      return;
    }
    if (req.url.startsWith('/run-digest')) {
      const qs = new URL(req.url, 'http://localhost').searchParams;
      const channel = qs.get('channel') || undefined;
      runDiscoveryDigest(channel);
      res.writeHead(200);
      res.end(`Digest triggered${channel ? ` → #${channel}` : ''}`);
      return;
    }
    if (req.url === '/run-daily-progress') {
      runDailyProgress(undefined, { force: true });
      res.writeHead(200);
      res.end('Daily progress triggered');
      return;
    }
    res.writeHead(200);
    res.end('ok');
  }).listen(PORT, () => {
    console.log(`  Health check on port ${PORT}`);
  });

  // Allow manual trigger via CLI: node slack_bot.js --run-digest
  if (process.argv.includes('--run-digest')) {
    await runDiscoveryDigest();
  }
})();
