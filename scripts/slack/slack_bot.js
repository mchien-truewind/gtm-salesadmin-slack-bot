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
  access_token: tokenData.token,
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

// ============================================================
// Read AI setup
// ============================================================
let readAiTokens = null;
let readAiOauthState = null;
const readAiTokensPath = path.resolve(__dirname, '../../secrets/read_ai_tokens.json');
const readAiOauthPath = path.resolve(__dirname, '../../secrets/read_ai_oauth_state.json');

if (fs.existsSync(readAiTokensPath)) {
  readAiTokens = JSON.parse(fs.readFileSync(readAiTokensPath, 'utf8'));
}
if (fs.existsSync(readAiOauthPath)) {
  readAiOauthState = JSON.parse(fs.readFileSync(readAiOauthPath, 'utf8'));
}
// For Railway: tokens from env vars
if (!readAiTokens && process.env.READ_AI_REFRESH_TOKEN) {
  readAiTokens = {
    access_token: process.env.READ_AI_ACCESS_TOKEN || '',
    refresh_token: process.env.READ_AI_REFRESH_TOKEN,
  };
  readAiOauthState = {
    client_id: process.env.READ_AI_CLIENT_ID,
    client_secret: process.env.READ_AI_CLIENT_SECRET,
    token_endpoint: process.env.READ_AI_TOKEN_ENDPOINT || 'https://authn.read.ai/oauth2/token',
    redirect_uri: process.env.READ_AI_REDIRECT_URI || 'https://api.read.ai/oauth/ui',
  };
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

async function refreshReadAiToken() {
  if (!readAiTokens || !readAiOauthState) return null;
  const refreshToken = readAiTokens.refresh_token;
  if (!refreshToken) return null;

  const clientId = readAiOauthState.client_id;
  const clientSecret = readAiOauthState.client_secret;
  const tokenEndpoint = readAiOauthState.token_endpoint;
  if (!clientId || !clientSecret || !tokenEndpoint) return null;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    redirect_uri: readAiOauthState.redirect_uri || '',
  }).toString();

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  try {
    const payload = await httpRequest(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Authorization': `Basic ${basic}`,
      },
      body,
    });

    if (payload.access_token) {
      readAiTokens.access_token = payload.access_token;
      if (payload.refresh_token) readAiTokens.refresh_token = payload.refresh_token;
      // Persist locally if possible
      if (fs.existsSync(path.dirname(readAiTokensPath))) {
        fs.writeFileSync(readAiTokensPath, JSON.stringify(readAiTokens, null, 2));
      }
      console.log('Read AI token refreshed');
      return payload.access_token;
    }
    console.error('Read AI refresh failed:', JSON.stringify(payload));
    return null;
  } catch (err) {
    console.error('Read AI refresh error:', err.message);
    return null;
  }
}

async function readAiRequest(endpoint, retried = false) {
  if (!readAiTokens) return { error: 'Read AI not configured' };
  const url = `https://api.read.ai/v1${endpoint}`;
  try {
    const result = await httpRequest(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${readAiTokens.access_token}`,
        'Accept': 'application/json',
      },
    });
    // If unauthorized, try refreshing token once
    if (result.error === 'request_unauthorized' && !retried) {
      const newToken = await refreshReadAiToken();
      if (newToken) return readAiRequest(endpoint, true);
    }
    return result;
  } catch (err) {
    return { error: err.message };
  }
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
  // --- Read AI tools ---
  {
    name: 'readai_list_meetings',
    description: 'List recent meetings from Read AI with transcripts and summaries. Returns meeting titles, dates, participants, and IDs.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max meetings to return (default 10, max 50)' },
      },
    },
  },
  {
    name: 'readai_get_meeting',
    description: 'Get full details of a Read AI meeting including summary, topics, key questions, and transcript.',
    input_schema: {
      type: 'object',
      properties: {
        meeting_id: { type: 'string', description: 'The Read AI meeting ID' },
      },
      required: ['meeting_id'],
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

    // --- Read AI ---
    if (name === 'readai_list_meetings') {
      const limit = input.limit || 10;
      const res = await readAiRequest(`/meetings?limit=${limit}`);
      if (res.error) return `Error: ${res.error}`;
      // Normalize response -- Read AI may return { items: [...] } or { meetings: [...] } or an array
      const meetings = res.data || res.items || res.meetings || (Array.isArray(res) ? res : []);
      return JSON.stringify(meetings.map(m => ({
        id: m.id,
        title: m.title || m.name,
        date: m.start_time_ms ? new Date(m.start_time_ms).toISOString() : (m.start_time || m.date || m.created_at),
        participants: m.participants || m.attendees,
        report_url: m.report_url,
        platform: m.platform,
      })));
    }
    if (name === 'readai_get_meeting') {
      // Try with expanded fields
      const params = new URLSearchParams([
        ['expand[]', 'summary'],
        ['expand[]', 'topics'],
        ['expand[]', 'key_questions'],
        ['expand[]', 'transcript'],
      ]);
      const res = await readAiRequest(`/meetings/${input.meeting_id}?${params}`);
      if (res.error) return `Error: ${res.error}`;
      return JSON.stringify(res);
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

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PRIORITY_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1RSdbMzBer3O5-dMExLsn3I3ZCCL8vNYMKWs44Z36hnI/edit?gid=0#gid=0';
const PRIORITY_SHEET_ID = '1RSdbMzBer3O5-dMExLsn3I3ZCCL8vNYMKWs44Z36hnI';

function getSystemPrompt() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  return `You are Truewind's internal AI assistant in Slack. You have tools for Google Sheets, HubSpot CRM, and Read AI meeting transcripts. You MUST use them when asked to take actions. NEVER say you can't do something -- you have the tools, use them.

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

## Read AI
You have access to Read AI meeting transcripts. You can list recent meetings and get full details including summaries, topics, key questions, and transcripts. Use this when asked about customer calls, meeting notes, or transcripts.

## General behavior
- Keep responses short and direct
- You receive full thread history. Use it to understand context.
- The Slack metadata (channel_id, thread_ts, thread_date) is appended to the last message.`;
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

(async () => {
  // Refresh Read AI token on startup so we always have a valid one
  if (readAiTokens && readAiOauthState) {
    const token = await refreshReadAiToken();
    console.log(`  Read AI: ${token ? 'ready (token refreshed)' : 'refresh FAILED'}`);
  } else {
    console.log(`  Read AI: NOT CONFIGURED`);
  }

  await app.start();
  console.log('Slack bot is running in socket mode');
  console.log(`  Google Sheets: ready`);
  console.log(`  HubSpot: ${HUBSPOT_TOKEN ? 'ready' : 'NOT CONFIGURED'}`);

  // Health check server for Railway (needs a port to know the service is alive)
  const PORT = process.env.PORT || 3000;
  http.createServer((req, res) => {
    res.writeHead(200);
    res.end('ok');
  }).listen(PORT, () => {
    console.log(`  Health check on port ${PORT}`);
  });
})();
