const https = require('https');
const http = require('http');

function normalizeBaseUrl(value) {
  return String(value || 'https://api.grain.com/_/public-api/v2').replace(/\/$/, '');
}

function parseListItems(payload) {
  if (Array.isArray(payload)) return { items: payload, cursor: '', hasMore: false };
  if (!payload || typeof payload !== 'object') return { items: [], cursor: '', hasMore: false };
  const items = payload.recordings || payload.data || payload.results || payload.items || [];
  const cursor = payload.next_cursor || payload.cursor || payload.next || payload.next_page_token || '';
  return {
    items: Array.isArray(items) ? items.filter(item => item && typeof item === 'object') : [],
    cursor: String(cursor || ''),
    hasMore: Boolean(payload.has_more || cursor),
  };
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let payload = data;
        try { payload = data ? JSON.parse(data) : {}; } catch {}
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const message = payload && typeof payload === 'object'
            ? (payload.message || payload.error || JSON.stringify(payload))
            : String(payload || '');
          const err = new Error(`Grain ${res.statusCode}: ${message}`);
          err.statusCode = res.statusCode;
          err.body = payload;
          reject(err);
          return;
        }
        resolve(payload);
      });
    });
    req.setTimeout(Number(options.timeoutMs || 30000), () => {
      req.destroy(new Error(`Grain request timed out after ${options.timeoutMs || 30000}ms`));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

class GrainClient {
  constructor({ token, baseUrl, logger = console, httpRequest = requestJson } = {}) {
    this.token = token;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.logger = logger;
    this.httpRequest = httpRequest;
  }

  isConfigured() {
    return Boolean(this.token);
  }

  async request(method, endpoint, body = null, headers = {}) {
    if (!this.token) throw new Error('Grain not configured');
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
    return this.httpRequest(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Public-Api-Version': '2025-10-31',
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async listRecordings({ start, end, pageSize = 100, maxPages = 10, include = ['participants', 'ai_action_items', 'ai_summary', 'calendar_event', 'hubspot'] } = {}) {
    const recordings = [];
    let cursor = '';
    for (let page = 0; page < maxPages; page++) {
      const body = {
        limit: Math.min(Number(pageSize) || 100, 100),
        include,
      };
      if (cursor) body.cursor = cursor;
      if (start || end) {
        body.filter = {
          ...(start ? { start_time: { gte: new Date(start).toISOString() } } : {}),
          ...(end ? { start_time: { lte: new Date(end).toISOString() } } : {}),
        };
      }
      let payload;
      try {
        payload = await this.request('POST', '/recordings', body);
      } catch (err) {
        if (page > 0) throw err;
        const params = new URLSearchParams({ limit: String(body.limit) });
        payload = await this.request('GET', `/recordings?${params.toString()}`);
      }
      const parsed = parseListItems(payload);
      recordings.push(...parsed.items);
      if (!parsed.hasMore || !parsed.cursor || parsed.items.length === 0) break;
      cursor = parsed.cursor;
    }
    return recordings;
  }

  async getRecording(recordingId) {
    const id = encodeURIComponent(recordingId);
    try {
      return await this.request('POST', `/recordings/${id}`, {
        include: ['participants', 'ai_action_items', 'ai_summary', 'calendar_event', 'hubspot', 'ai_template_sections'],
      });
    } catch (err) {
      return this.request('GET', `/recordings/${id}`);
    }
  }

  async getTranscript(recordingId) {
    const id = encodeURIComponent(recordingId);
    try {
      return await this.request('GET', `/recordings/${id}/transcript`);
    } catch (err) {
      return this.request('GET', `/recordings/${id}/transcript.txt`, null, { Accept: 'text/plain' });
    }
  }
}

module.exports = {
  GrainClient,
  parseListItems,
};
