const fs = require('fs');
const path = require('path');

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

// --- Google Sheets setup ---
// In production, these come from env vars; locally, from secrets file
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

// --- Tool definitions for Claude ---
const TOOLS = [
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
];

// --- Tool execution ---
async function executeTool(name, input) {
  try {
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
    return `Unknown tool: ${name}`;
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// --- Slack app setup ---
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
  const today = new Date().toISOString().split('T')[0];
  return `You are Truewind's internal AI assistant in Slack. You have tools to read and write Google Sheets. You MUST use them when asked to add things to spreadsheets. NEVER say you can't edit a sheet -- you have the tools, use them.

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

## Response format
After successfully appending, respond with EXACTLY this and nothing else:
:white_check_mark: Done. Priority list here: ${PRIORITY_SHEET_URL}

## General behavior
- Keep responses short and direct
- You receive full thread history. Use it to understand context.
- The Slack metadata (channel_id, thread_ts, thread_date) is appended to the last message.`;
}

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
  await app.start();
  console.log('Slack bot is running in socket mode');
})();
