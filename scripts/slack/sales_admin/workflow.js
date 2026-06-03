const path = require('path');
const {
  dedupeGrainRecordings,
  findBestGrainRecordingForMeeting,
  formatGrainTranscriptText,
  getGrainParticipantEmails,
  getGrainRecordingId,
  getGrainRecordingStartMs,
  getGrainRecordingTitle,
  getGrainRecordingUrl,
  normalizeDigestText,
} = require('../discovery_digest');
const { GrainClient } = require('./grain_client');
const { HubSpotSalesAdminClient } = require('./hubspot_sales_admin');
const { createSalesAdminState } = require('./state');

const DEFAULT_AE_ROSTER = [
  { name: 'Xavier Marco', hubspotOwnerId: '89305622', email: 'xavier@trytruewind.com', slackUserId: 'U0AKMHVCJMA', salesAdminChannel: 'gtm-salesadmin-xavier' },
  { name: 'Sarah Elix', hubspotOwnerId: '84547076', email: 'sarah@trytruewind.com', slackUserId: 'U09QC3B292R', salesAdminChannel: 'gtm-salesadmin-sarah' },
  { name: 'Jenilee Chen', hubspotOwnerId: '91143842', email: 'jenilee@trytruewind.com', slackUserId: 'U0ATZSNCE5T', salesAdminChannel: 'gtm-salesadmin-jenilee' },
  { name: 'Mercedes Chien', hubspotOwnerId: '87811681', email: 'mercedes@trytruewind.com', slackUserId: 'U0ABULY5TEK', salesAdminChannel: 'gtm-salesadmin-mercedes' },
  { name: 'Alex Lee', hubspotOwnerId: '60918610', email: 'alex@trytruewind.com', slackUserId: 'U04BPMPR29G', salesAdminChannel: 'gtm-salesadmin-alex' },
  { name: 'Amy Vetter', hubspotOwnerId: '92555980', email: 'amy@trytruewind.com', slackUserId: 'U0B4MRN83FE', salesAdminChannel: 'gtm-salesadmin-amy' },
];

const INTERNAL_DOMAINS = new Set(['trytruewind.com']);
const POST_ACTIONS = {
  confirm: 'sales_admin_confirm',
  edit: 'sales_admin_edit',
  stageSelect: 'sales_admin_stage_select',
  noShow: 'sales_admin_no_show',
  ignore: 'sales_admin_ignore',
  editSubmit: 'sales_admin_edit_submit',
};

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseNumber(value, defaultValue) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseRoster(rawValue = '') {
  const raw = String(rawValue || '').trim();
  const roster = raw ? JSON.parse(raw) : DEFAULT_AE_ROSTER;
  if (!Array.isArray(roster)) throw new Error('SALES_ADMIN_AE_ROSTER_JSON must be a JSON array');
  return roster.map((item, index) => {
    const ae = {
      name: String(item.name || '').trim(),
      hubspotOwnerId: String(item.hubspotOwnerId || item.hubspot_owner_id || '').trim(),
      email: String(item.email || '').trim().toLowerCase(),
      slackUserId: String(item.slackUserId || item.slack_user_id || '').trim(),
      salesAdminChannel: String(item.salesAdminChannel || item.sales_admin_channel || item.channel || '').trim().replace(/^#/, ''),
    };
    const missing = ['name', 'hubspotOwnerId', 'email', 'slackUserId', 'salesAdminChannel'].filter(key => !ae[key]);
    if (missing.length) throw new Error(`AE roster item ${index + 1} missing: ${missing.join(', ')}`);
    return ae;
  });
}

function buildConfig(env = process.env) {
  return {
    enabled: parseBoolean(env.SALES_ADMIN_ENABLED, false),
    timezone: env.SALES_ADMIN_TZ || 'America/Los_Angeles',
    morningHour: parseNumber(env.SALES_ADMIN_MORNING_HOUR, 8),
    morningMinute: parseNumber(env.SALES_ADMIN_MORNING_MINUTE, 0),
    postMeetingDelayMin: parseNumber(env.SALES_ADMIN_POST_MEETING_DELAY_MIN, 10),
    scanIntervalMin: parseNumber(env.SALES_ADMIN_SCAN_MIN, 5),
    cancelScanMin: parseNumber(env.SALES_ADMIN_CANCEL_SCAN_MIN, 5),
    cancelLookbackMin: parseNumber(env.SALES_ADMIN_CANCEL_LOOKBACK_MIN, 30),
    cancelPastGraceHours: parseNumber(env.SALES_ADMIN_CANCEL_PAST_GRACE_HOURS, 24),
    createTasks: parseBoolean(env.SALES_ADMIN_CREATE_TASKS, false),
    portalId: env.HUBSPOT_PORTAL_ID || '43974586',
    statePath: env.SALES_ADMIN_STATE_PATH || path.resolve(process.cwd(), 'data/sales_admin_state.json'),
    grainToken: env.GRAIN_API_TOKEN || env.GRAIN_API || env.GRAIN_ACCESS_TOKEN || env.GRAIN_WORKSPACE_TOKEN || '',
    grainBaseUrl: env.GRAIN_API_BASE || 'https://api.grain.com/_/public-api/v2',
    roster: parseRoster(env.SALES_ADMIN_AE_ROSTER_JSON),
  };
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return asUtc - date.getTime();
}

function zonedLocalToUtc(year, month, day, hour, minute, second, timeZone) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offset = getTimeZoneOffsetMs(guess, timeZone);
  return new Date(guess.getTime() - offset);
}

function getLocalDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    dateKey: `${values.year}-${values.month}-${values.day}`,
  };
}

function getLocalDayRange(now = new Date(), timeZone = 'America/Los_Angeles') {
  const parts = getLocalDateParts(now, timeZone);
  const start = zonedLocalToUtc(parts.year, parts.month, parts.day, 0, 0, 0, timeZone);
  const nextDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 0, 0, 0));
  const nextParts = getLocalDateParts(nextDay, 'UTC');
  const end = zonedLocalToUtc(nextParts.year, nextParts.month, nextParts.day, 0, 0, 0, timeZone);
  return { start, end, dateKey: parts.dateKey };
}

function formatLocalTime(iso, timeZone = 'America/Los_Angeles') {
  if (!iso) return 'time unknown';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'time unknown';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function formatLocalDateTime(iso, timeZone = 'America/Los_Angeles') {
  if (!iso) return 'time unknown';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'time unknown';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function classifyMeetingStatus(meeting) {
  const props = meeting?.properties || {};
  const title = normalizeDigestText(props.hs_meeting_title || meeting?.title || '');
  const outcome = String(props.hs_meeting_outcome || '').trim().toUpperCase();
  if (outcome === 'CANCELED' || outcome === 'CANCELLED') return 'cancelled';
  if (title.startsWith('canceled:') || title.startsWith('cancelled:')) return 'cancelled';
  if (/^\[cancell?ed\]/.test(title)) return 'cancelled';
  return 'scheduled';
}

function cancellationSourceLabel(meeting) {
  const props = meeting?.properties || {};
  const title = normalizeDigestText(props.hs_meeting_title || '');
  if (String(props.hs_object_source_detail_1 || '').toLowerCase() === 'calendly') return 'Calendly';
  if (String(props.hs_object_source_id || '').toLowerCase() === 'calendarsync') return 'CalendarSync';
  if (String(props.hs_meeting_source || '').toUpperCase() === 'BIDIRECTIONAL_SYNC') return 'CalendarSync';
  if (title.includes('calendly')) return 'Calendly';
  return 'Unknown';
}

function meetingEndMs(meeting, defaultDurationMin = 60) {
  const props = meeting?.properties || {};
  const end = props.hs_meeting_end_time ? Date.parse(props.hs_meeting_end_time) : 0;
  if (Number.isFinite(end) && end > 0) return end;
  const start = props.hs_meeting_start_time ? Date.parse(props.hs_meeting_start_time) : 0;
  return Number.isFinite(start) && start > 0 ? start + defaultDurationMin * 60 * 1000 : 0;
}

function meetingTitle(meeting) {
  return String(meeting?.properties?.hs_meeting_title || meeting?.title || 'Untitled meeting').trim();
}

function primaryContact(meeting) {
  return meeting?._contacts?.[0] || null;
}

function primaryCompany(meeting) {
  return meeting?._companies?.[0] || null;
}

function primaryDeal(meeting) {
  return meeting?._deals?.[0] || null;
}

function contactLabel(contact) {
  if (!contact) return '';
  const name = `${contact.firstname || ''} ${contact.lastname || ''}`.trim();
  const company = contact.company ? ` (${contact.company})` : '';
  return `${name || contact.email || 'Contact'}${company}`;
}

function slackLink(url, label) {
  return url ? `<${url}|${label}>` : label;
}

function slackPlainText(value, maxLength = 75) {
  const text = String(value || '').trim() || 'Option';
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function meetingLinks(hubspot, meeting) {
  const links = [slackLink(hubspot.recordUrl('meetings', meeting.id), 'HubSpot meeting')];
  const contact = primaryContact(meeting);
  const company = primaryCompany(meeting);
  const deal = primaryDeal(meeting);
  if (contact?.id) links.push(slackLink(hubspot.recordUrl('contacts', contact.id), contactLabel(contact)));
  if (company?.id) links.push(slackLink(hubspot.recordUrl('companies', company.id), company.name || 'Company'));
  if (deal?.id) links.push(slackLink(hubspot.recordUrl('deals', deal.id), deal.dealname || 'Deal'));
  return links.join(' | ');
}

function isInternalEmail(email) {
  const normalized = normalizeDigestText(email);
  const domain = normalized.includes('@') ? normalized.split('@').pop() : '';
  return INTERNAL_DOMAINS.has(domain);
}

function getMeetingEmails(meeting) {
  return (meeting?._contacts || [])
    .map(contact => normalizeDigestText(contact.email))
    .filter(Boolean);
}

function recordingDirectlyMatchesMeeting(recording, meeting) {
  const meetingId = String(meeting?.id || '').trim();
  const sourceId = String(meeting?.properties?.hs_meeting_source_id || '').trim();
  const externalUrl = String(meeting?.properties?.hs_meeting_external_url || '').trim();
  const hubspotPayload = JSON.stringify(recording?.hubspot || recording?.hubspot_metadata || recording?.hubspot_event || {});
  if (meetingId && hubspotPayload.includes(meetingId)) return true;

  const event = recording?.calendar_event || recording?.calendarEvent || {};
  const eventValues = [
    event.id,
    event.uid,
    event.event_id,
    event.calendar_event_id,
    event.html_link,
    event.htmlLink,
    event.url,
  ].map(value => String(value || '').trim()).filter(Boolean);
  if (sourceId && eventValues.some(value => value === sourceId || value.includes(sourceId))) return true;
  if (externalUrl && eventValues.some(value => value === externalUrl)) return true;
  return false;
}

function getRecordingText(recording) {
  const actionItems = recording?.ai_action_items || recording?.action_items || recording?.next_steps || [];
  const summary = recording?.ai_summary || recording?.summary || recording?.overview || '';
  const transcript = formatGrainTranscriptText(recording);
  const actionText = Array.isArray(actionItems)
    ? actionItems.map(item => (typeof item === 'string' ? item : item.text || item.description || item.title || '')).filter(Boolean).join('\n')
    : String(actionItems || '');
  return [actionText, typeof summary === 'object' ? JSON.stringify(summary) : summary, transcript].filter(Boolean).join('\n\n');
}

function normalizeExtraction(raw = {}) {
  const nextSteps = Array.isArray(raw.next_steps) ? raw.next_steps : [];
  return {
    outcome: String(raw.outcome || '').trim() || 'Needs AE confirmation',
    nextSteps: nextSteps.map(step => ({
      text: String(step.text || step.description || step.action || step || '').trim(),
      owner: String(step.owner || '').trim(),
      dueDate: String(step.due_date || step.dueDate || '').trim(),
    })).filter(step => step.text),
    confidence: ['high', 'medium', 'low'].includes(String(raw.confidence || '').toLowerCase())
      ? String(raw.confidence).toLowerCase()
      : 'low',
    source: raw.source || 'unknown',
  };
}

async function extractNextSteps({ anthropic, recording, logger = console }) {
  const actionItems = recording?.ai_action_items || recording?.action_items || recording?.next_steps;
  if (Array.isArray(actionItems) && actionItems.length > 0) {
    return normalizeExtraction({
      outcome: recording?.ai_summary?.summary || recording?.summary || 'Meeting completed; review next steps.',
      next_steps: actionItems.map(item => (typeof item === 'string' ? { text: item } : item)),
      confidence: 'high',
      source: 'grain_ai_action_items',
    });
  }

  const text = getRecordingText(recording).slice(0, 8000);
  if (!text || !anthropic) {
    return normalizeExtraction({ source: recording ? 'grain_recording_no_extractable_notes' : 'no_grain_recording' });
  }

  try {
    const res = await anthropic.messages.create({
      model: process.env.SALES_ADMIN_CLAUDE_MODEL || 'claude-sonnet-4-6',
      max_tokens: 700,
      system: 'Extract sales meeting outcome and next steps. Return only valid JSON. Never invent facts.',
      messages: [{
        role: 'user',
        content: `From these meeting notes/transcript, extract the outcome and explicit next steps. If no next steps are explicit, return an empty next_steps array and confidence low.\n\nJSON schema:\n{"outcome":"string","next_steps":[{"text":"string","owner":"string","due_date":"string"}],"confidence":"high|medium|low"}\n\nMeeting content:\n${text}`,
      }],
    });
    const responseText = res.content?.find(block => block.type === 'text')?.text || '{}';
    const jsonText = responseText.match(/\{[\s\S]*\}/)?.[0] || '{}';
    return normalizeExtraction({ ...JSON.parse(jsonText), source: 'grain_transcript_claude' });
  } catch (err) {
    logger.warn(`Sales admin next-step extraction failed: ${err.message}`);
    return normalizeExtraction({ source: 'extraction_failed' });
  }
}

async function extractPriorTips({ anthropic, priorMeeting, logger = console }) {
  if (!priorMeeting) return ['No prior meeting context found.'];
  const props = priorMeeting.properties || {};
  const text = [props.hs_meeting_title, props.hs_meeting_body].filter(Boolean).join('\n\n').slice(0, 5000);
  if (!text) return ['Prior meeting found, but no notes were available.'];
  if (!anthropic) return [String(props.hs_meeting_title || 'Review prior HubSpot meeting notes.')];
  try {
    const res = await anthropic.messages.create({
      model: process.env.SALES_ADMIN_CLAUDE_MODEL || 'claude-sonnet-4-6',
      max_tokens: 300,
      system: 'Extract concise reminders for an AE before a follow-up sales meeting.',
      messages: [{
        role: 'user',
        content: `Return 1-3 short bullet reminders from this prior meeting. No preamble.\n\n${text}`,
      }],
    });
    const responseText = res.content?.find(block => block.type === 'text')?.text || '';
    const tips = responseText.split(/\n+/).map(line => line.replace(/^[-*•]\s*/, '').trim()).filter(Boolean).slice(0, 3);
    return tips.length ? tips : ['Review prior HubSpot meeting notes.'];
  } catch (err) {
    logger.warn(`Sales admin prior-tip extraction failed: ${err.message}`);
    return ['Review prior HubSpot meeting notes.'];
  }
}

function inputElement(initialValue) {
  const element = { type: 'plain_text_input', action_id: 'value', multiline: true };
  if (String(initialValue || '').trim()) element.initial_value = String(initialValue);
  return element;
}

function slackMrkdwn(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncateText(value, maxLength = 2900) {
  const text = String(value || '');
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function outcomeBlockText(extraction) {
  return truncateText(`*Outcome from Grain*\n${slackMrkdwn(extraction?.outcome || 'Needs AE confirmation.')}`);
}

function nextStepsBlockText(extraction) {
  const steps = extraction?.nextSteps || [];
  if (!steps.length) {
    return '*Next steps from Grain*\n_No next steps were found in Grain. Click Edit Notes to add them before saving._';
  }
  const lines = steps.slice(0, 8).map((step, index) => {
    const suffix = [step.owner ? `Owner: ${slackMrkdwn(step.owner)}` : '', step.dueDate ? `Due: ${slackMrkdwn(step.dueDate)}` : ''].filter(Boolean).join(', ');
    return `${index + 1}. ${slackMrkdwn(step.text)}${suffix ? ` _(${suffix})_` : ''}`;
  });
  if (steps.length > lines.length) lines.push(`_${steps.length - lines.length} more next steps omitted. Click Edit Notes to review._`);
  return truncateText(`*Next steps from Grain*\n${lines.join('\n')}`);
}

function stageBlockText(stageDecision) {
  if (!stageDecision) return '';
  const recommendedVerb = stageDecision.recommendedStageId === stageDecision.currentStageId ? 'keep it in' : 'move it to';
  return [
    `*Deal stage: ${slackMrkdwn(stageDecision.dealName)}*`,
    `Current stage: *${slackMrkdwn(stageDecision.currentStageLabel)}*`,
    `Recommended: *${recommendedVerb} ${slackMrkdwn(stageDecision.recommendedStageLabel)}*`,
    'Dropdown default is the recommendation. Choose the current stage if the deal should stay put.',
  ].join('\n');
}

function stageLabel(stage) {
  return stage?.label || stage?.id || '';
}

function buildStageDecision({ deal, stages = [] } = {}) {
  if (!deal?.id || !Array.isArray(stages) || stages.length === 0) return null;
  const currentStageId = String(deal.dealstage || '').trim();
  const currentIndex = stages.findIndex(stage => stage.id === currentStageId);
  if (currentIndex < 0) return null;
  const options = stages.slice(currentIndex);
  const recommendedIndex = Math.min(currentIndex + 1, stages.length - 1);
  const recommendedStage = stages[recommendedIndex];
  const currentStage = stages[currentIndex];
  return {
    dealId: deal.id,
    dealName: deal.dealname || 'Associated deal',
    pipelineId: deal.pipeline || '105321581',
    currentStageId,
    currentStageLabel: stageLabel(currentStage),
    recommendedStageId: recommendedStage.id,
    recommendedStageLabel: stageLabel(recommendedStage),
    options,
    recommendationReason: recommendedStage.id === currentStageId
      ? 'Deal is already in the last configured stage.'
      : 'Default recommendation is the next pipeline stage after this meeting.',
  };
}

function stageSelectElement(stageDecision, selectedStageId) {
  if (!stageDecision?.options?.length) return null;
  const options = stageDecision.options.slice(0, 100).map(stage => ({
    text: { type: 'plain_text', text: slackPlainText(stage.label), emoji: true },
    value: stage.id,
  }));
  const initialValue = selectedStageId || stageDecision.recommendedStageId || stageDecision.currentStageId;
  const initialOption = options.find(option => option.value === initialValue) || options[0];
  return {
    type: 'static_select',
    action_id: POST_ACTIONS.stageSelect,
    placeholder: { type: 'plain_text', text: 'Move deal to...', emoji: true },
    options,
    ...(initialOption ? { initial_option: initialOption } : {}),
  };
}

function selectedStageFromInteraction(body, fallbackStageId = '') {
  const values = body?.state?.values || {};
  for (const block of Object.values(values)) {
    for (const actionValue of Object.values(block || {})) {
      if (actionValue?.action_id === POST_ACTIONS.stageSelect && actionValue?.selected_option?.value) {
        return String(actionValue.selected_option.value);
      }
    }
  }
  return fallbackStageId || '';
}

function selectedStageLabel(stageDecision, stageId) {
  return stageDecision?.options?.find(stage => stage.id === stageId)?.label || '';
}

function buildWritebackNote({ ae, meeting, status, extraction, grainUrl = '', editedOutcome = '', editedNextSteps = '', stageDecision = null, selectedStageId = '', stageUpdate = null }) {
  const lines = [
    'Sales Admin Confirmed Meeting Outcome',
    `AE: ${ae.name} <${ae.email}>`,
    `Status: ${status}`,
    `Meeting: ${meetingTitle(meeting)}`,
    `Meeting time: ${meeting.properties?.hs_meeting_start_time || ''}`,
  ];
  if (grainUrl) lines.push(`Grain recording: ${grainUrl}`);
  if (stageDecision) {
    lines.push(`Deal stage before confirmation: ${stageDecision.currentStageLabel}`);
    if (status !== 'no_show') lines.push(`Confirmed deal stage: ${selectedStageLabel(stageDecision, selectedStageId) || selectedStageId || 'Not selected'}`);
    if (stageUpdate?.updated) lines.push(`Deal stage updated in HubSpot: ${stageUpdate.fromLabel} -> ${stageUpdate.toLabel}`);
    if (stageUpdate && !stageUpdate.updated) lines.push(`Deal stage update: ${stageUpdate.reason}`);
  }
  if (status === 'no_show') {
    lines.push('Outcome: No show');
  } else {
    lines.push(`Outcome: ${editedOutcome || extraction?.outcome || 'Confirmed'}`);
    const steps = editedNextSteps
      ? editedNextSteps.split(/\n+/).map(text => ({ text: text.trim() })).filter(step => step.text)
      : (extraction?.nextSteps || []);
    lines.push('Next steps:');
    if (steps.length) {
      for (const step of steps) lines.push(`- ${step.text}${step.owner ? ` (Owner: ${step.owner})` : ''}${step.dueDate ? ` (Due: ${step.dueDate})` : ''}`);
    } else {
      lines.push('- None confirmed');
    }
  }
  return lines.join('\n');
}

function buildPostMeetingBlocks({ ae, meeting, hubspot, extraction, promptKey, grainUrl, stageDecision }) {
  const instruction = stageDecision
    ? 'review the notes, choose the deal stage, then save to HubSpot.'
    : 'review the notes, then save to HubSpot.';
  const text = `:clipboard: *Post-meeting check: ${slackMrkdwn(meetingTitle(meeting))}*\n<@${ae.slackUserId}> ${instruction}`;
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${formatLocalDateTime(meeting.properties?.hs_meeting_start_time)} | ${meetingLinks(hubspot, meeting)}${grainUrl ? ` | <${grainUrl}|Grain recording>` : ''}` }] },
    { type: 'section', text: { type: 'mrkdwn', text: outcomeBlockText(extraction) } },
    { type: 'section', text: { type: 'mrkdwn', text: nextStepsBlockText(extraction) } },
    ...(stageDecision ? [{
      type: 'section',
      block_id: 'deal_stage',
      text: { type: 'mrkdwn', text: stageBlockText(stageDecision) },
      accessory: stageSelectElement(stageDecision, stageDecision.recommendedStageId),
    }] : []),
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: stageDecision
          ? ':information_source: *Confirm & Save* writes a HubSpot note and applies the selected deal stage. To avoid moving the deal, select the current stage.'
          : ':information_source: *Confirm & Save* writes these notes back to HubSpot.',
      }],
    },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Confirm & Save' }, style: 'primary', action_id: POST_ACTIONS.confirm, value: promptKey },
        { type: 'button', text: { type: 'plain_text', text: 'Edit Notes' }, action_id: POST_ACTIONS.edit, value: promptKey },
        { type: 'button', text: { type: 'plain_text', text: 'No-Show' }, style: 'danger', action_id: POST_ACTIONS.noShow, value: promptKey },
        {
          type: 'overflow',
          action_id: POST_ACTIONS.ignore,
          options: [{ text: { type: 'plain_text', text: 'Not this meeting', emoji: true }, value: promptKey }],
        },
      ],
    },
  ];
}

async function findChannelIdByName(client, token, channelName, types) {
  let cursor = '';
  do {
    const res = await client.conversations.list({
      token,
      exclude_archived: true,
      types,
      limit: 1000,
      cursor: cursor || undefined,
    });
    const channel = (res.channels || []).find(item => item.name === channelName);
    if (channel) return channel.id;
    cursor = res.response_metadata?.next_cursor || '';
  } while (cursor);
  return '';
}

async function resolveChannelId(client, token, channelName, { includePrivate = false, logger = console } = {}) {
  const normalizedName = String(channelName || '').replace(/^#/, '');
  if (/^[CDG][A-Z0-9]+$/.test(normalizedName)) return normalizedName;
  const publicChannelId = await findChannelIdByName(client, token, normalizedName, 'public_channel');
  if (publicChannelId) return publicChannelId;
  if (!includePrivate) return '';
  try {
    return await findChannelIdByName(client, token, normalizedName, 'private_channel');
  } catch (err) {
    if (err?.data?.error === 'missing_scope') {
      logger.warn(`Sales admin private channel lookup skipped for #${normalizedName}: missing Slack scope groups:read`);
      return '';
    }
    throw err;
  }
}

class SalesAdminWorkflow {
  constructor({ app, hubspotRequest, anthropic, env = process.env, logger = console } = {}) {
    this.app = app;
    this.anthropic = anthropic;
    this.env = env;
    this.logger = logger;
    this.config = buildConfig(env);
    this.state = createSalesAdminState(this.config.statePath, logger);
    this.hubspot = new HubSpotSalesAdminClient({ hubspotRequest, portalId: this.config.portalId, logger });
    this.grain = new GrainClient({ token: this.config.grainToken, baseUrl: this.config.grainBaseUrl, logger });
    this.channelIdsByOwnerId = new Map();
    this.missingChannelsByOwnerId = new Set();
    this.inFlight = new Set();
  }

  isEnabled() {
    return this.config.enabled;
  }

  async initializeChannels() {
    if (!this.app?.client || !this.isEnabled()) return;
    for (const ae of this.config.roster) {
      try {
        const channelId = await resolveChannelId(this.app.client, this.env.SLACK_BOT_TOKEN, ae.salesAdminChannel, {
          includePrivate: this.env.SALES_ADMIN_RESOLVE_PRIVATE_CHANNELS === 'true',
          logger: this.logger,
        });
        if (!channelId) {
          this.logger.error(`Sales admin channel not found for ${ae.name}: #${ae.salesAdminChannel}; skipping this AE until the channel exists and the bot is invited.`);
          this.missingChannelsByOwnerId.add(ae.hubspotOwnerId);
          continue;
        }
        this.missingChannelsByOwnerId.delete(ae.hubspotOwnerId);
        this.channelIdsByOwnerId.set(ae.hubspotOwnerId, channelId);
      } catch (err) {
        this.logger.error(`Sales admin channel resolution failed for ${ae.name}: ${err.message}`);
      }
    }
  }

  isAeChannelReady(ae) {
    if (/^[CDG][A-Z0-9]+$/.test(ae.salesAdminChannel)) return true;
    return this.channelIdsByOwnerId.has(ae.hubspotOwnerId) && !this.missingChannelsByOwnerId.has(ae.hubspotOwnerId);
  }

  channelFor(ae) {
    return this.channelIdsByOwnerId.get(ae.hubspotOwnerId) || ae.salesAdminChannel;
  }

  async safePostMessage(ae, payload) {
    if (!this.isAeChannelReady(ae)) {
      throw new Error(`Configured sales-admin channel is not ready for ${ae.name}: #${ae.salesAdminChannel}`);
    }
    const channel = this.channelFor(ae);
    try {
      return await this.app.client.chat.postMessage({
        token: this.env.SLACK_BOT_TOKEN,
        channel,
        ...payload,
      });
    } catch (err) {
      this.logger.error(`Sales admin Slack post failed for ${ae.name} in ${channel}: ${err.message}`);
      throw err;
    }
  }

  async withLock(name, fn) {
    if (this.inFlight.has(name)) {
      this.logger.log(`Sales admin ${name} already running; skipping duplicate run.`);
      return { skipped: true, reason: 'in_flight' };
    }
    this.inFlight.add(name);
    try {
      return await fn();
    } finally {
      this.inFlight.delete(name);
    }
  }

  async meetingsForToday(ae, now = new Date()) {
    const { start, end } = getLocalDayRange(now, this.config.timezone);
    const meetings = await this.hubspot.searchMeetingsForOwnerBetween(ae.hubspotOwnerId, start, end);
    return Promise.all(meetings.map(meeting => this.hubspot.attachAssociations(meeting)));
  }

  async runMorningSummaries(now = new Date()) {
    if (!this.isEnabled()) return { skipped: true, reason: 'disabled' };
    return this.withLock('morning', async () => {
      const { dateKey } = getLocalDayRange(now, this.config.timezone);
      const stats = { posted: 0, skipped: 0, errors: 0 };
      for (const ae of this.config.roster) {
        if (!this.isAeChannelReady(ae)) { stats.skipped += 1; continue; }
        const key = `morning:${dateKey}:${ae.hubspotOwnerId}`;
        if (this.state.has(key)) { stats.skipped += 1; continue; }
        try {
          const meetings = await this.meetingsForToday(ae, now);
          const scheduled = meetings.filter(meeting => classifyMeetingStatus(meeting) !== 'cancelled');
          const cancelled = meetings.filter(meeting => classifyMeetingStatus(meeting) === 'cancelled' && !this.state.has(`cancel:${meeting.id}:${ae.hubspotOwnerId}`));
          const lines = [`Good morning <@${ae.slackUserId}>. Here are your meetings for today.`];
          if (scheduled.length === 0) lines.push('\nNo scheduled meetings found.');
          for (const meeting of scheduled) {
            const prior = await this.hubspot.findPriorMeeting(meeting);
            const tips = await extractPriorTips({ anthropic: this.anthropic, priorMeeting: prior, logger: this.logger });
            lines.push(`\n*${formatLocalTime(meeting.properties?.hs_meeting_start_time, this.config.timezone)} - ${meetingTitle(meeting)}*`);
            lines.push(meetingLinks(this.hubspot, meeting));
            lines.push(`Tips: ${tips.map(tip => `• ${tip}`).join(' ')}`);
          }
          if (cancelled.length > 0) {
            lines.push('\n*Cancelled today, not yet separately alerted:*');
            for (const meeting of cancelled) lines.push(`- ${formatLocalTime(meeting.properties?.hs_meeting_start_time, this.config.timezone)} - ${meetingTitle(meeting)}`);
          }
          const posted = await this.safePostMessage(ae, { text: lines.join('\n') });
          this.state.set(key, { type: 'morning', ae, dateKey, slackTs: posted.ts, slackChannel: posted.channel || this.channelFor(ae), status: 'posted' });
          stats.posted += 1;
        } catch (err) {
          stats.errors += 1;
          this.logger.error(`Sales admin morning summary failed for ${ae.name}: ${err.message}`);
        }
      }
      return stats;
    });
  }

  async runCancellationScan(now = new Date()) {
    if (!this.isEnabled()) return { skipped: true, reason: 'disabled' };
    return this.withLock('cancel', async () => {
      const stats = { alerted: 0, skipped: 0, errors: 0 };
      const updatedSince = new Date(now.getTime() - this.config.cancelLookbackMin * 60 * 1000);
      const startAfter = new Date(now.getTime() - this.config.cancelPastGraceHours * 60 * 60 * 1000);
      for (const ae of this.config.roster) {
        if (!this.isAeChannelReady(ae)) { stats.skipped += 1; continue; }
        try {
          const meetings = await this.hubspot.searchRecentlyUpdatedMeetingsForOwner(ae.hubspotOwnerId, updatedSince, startAfter);
          for (const rawMeeting of meetings) {
            if (classifyMeetingStatus(rawMeeting) !== 'cancelled') continue;
            const key = `cancel:${rawMeeting.id}:${ae.hubspotOwnerId}`;
            if (this.state.has(key)) { stats.skipped += 1; continue; }
            const meeting = await this.hubspot.attachAssociations(rawMeeting);
            const source = cancellationSourceLabel(meeting);
            const text = [
              `:warning: <@${ae.slackUserId}> meeting cancelled: *${meetingTitle(meeting)}*`,
              `Original time: ${formatLocalDateTime(meeting.properties?.hs_meeting_start_time, this.config.timezone)}`,
              `Source: ${source}`,
              meetingLinks(this.hubspot, meeting),
            ].join('\n');
            const posted = await this.safePostMessage(ae, { text });
            const note = await this.hubspot.createNote({
              meeting,
              contacts: meeting._contacts,
              companies: meeting._companies,
              deals: meeting._deals,
              body: [
                'Sales Admin cancellation notification',
                `AE notified: ${ae.name} <${ae.email}>`,
                `Slack channel: ${posted.channel || this.channelFor(ae)}`,
                `Slack timestamp: ${posted.ts}`,
                `Detected source: ${source}`,
                `Cancellation signal: ${meeting.properties?.hs_meeting_title || ''}`,
              ].join('\n'),
            });
            this.state.set(key, { type: 'cancel', ae, meetingId: meeting.id, source, slackTs: posted.ts, slackChannel: posted.channel || this.channelFor(ae), hubspotNoteId: note.id, status: 'alerted' });
            stats.alerted += 1;
          }
        } catch (err) {
          stats.errors += 1;
          this.logger.error(`Sales admin cancellation scan failed for ${ae.name}: ${err.message}`);
        }
      }
      return stats;
    });
  }

  async fetchGrainForMeeting(ae, meeting) {
    if (!this.grain.isConfigured()) return { recording: null, grainUrl: '', source: 'grain_not_configured' };
    const startMs = Date.parse(meeting.properties?.hs_meeting_start_time || '');
    if (!Number.isFinite(startMs)) return { recording: null, grainUrl: '', source: 'missing_meeting_start' };
    const recordings = await this.grain.listRecordings({
      start: new Date(startMs - 45 * 60 * 1000),
      end: new Date(startMs + 45 * 60 * 1000),
      maxPages: Number(this.env.SALES_ADMIN_GRAIN_MAX_PAGES || 5),
    });
    const config = { matchWindowMs: 45 * 60 * 1000 };
    const dedupedRecordings = dedupeGrainRecordings(recordings);
    let matched = dedupedRecordings.find(recording => recordingDirectlyMatchesMeeting(recording, meeting)) || null;
    if (!matched) matched = findBestGrainRecordingForMeeting(meeting, dedupedRecordings, config);
    if (!matched) {
      const meetingEmails = new Set(getMeetingEmails(meeting));
      matched = dedupeGrainRecordings(recordings).find(recording => {
        const emails = getGrainParticipantEmails(recording);
        return emails.includes(ae.email) && emails.some(email => meetingEmails.has(email) || !isInternalEmail(email));
      }) || null;
    }
    if (!matched) return { recording: null, grainUrl: '', source: 'no_grain_recording' };
    const id = getGrainRecordingId(matched);
    let detail = matched;
    try {
      if (id) detail = { ...matched, ...(await this.grain.getRecording(id)) };
      if (id && !formatGrainTranscriptText(detail)) detail.transcript = await this.grain.getTranscript(id);
    } catch (err) {
      this.logger.warn(`Sales admin Grain detail fetch failed for ${id || getGrainRecordingTitle(matched)}: ${err.message}`);
    }
    return { recording: detail, grainUrl: getGrainRecordingUrl(detail) || getGrainRecordingUrl(matched), source: 'grain_matched' };
  }

  async runPostMeetingScan(now = new Date(), options = {}) {
    if (!this.isEnabled()) return { skipped: true, reason: 'disabled' };
    return this.withLock('post', async () => {
      const stats = { prompted: 0, skipped: 0, errors: 0 };
      const ownerId = String(options.ownerId || options.owner_id || '').trim();
      const meetingId = String(options.meetingId || options.meeting_id || '').trim();
      const force = options.force === true || options.force === 'true' || options.force === '1';
      for (const ae of this.config.roster) {
        if (ownerId && ae.hubspotOwnerId !== ownerId) { stats.skipped += 1; continue; }
        if (!this.isAeChannelReady(ae)) { stats.skipped += 1; continue; }
        try {
          const meetings = await this.meetingsForToday(ae, now);
          for (const meeting of meetings) {
            if (meetingId && String(meeting.id) !== meetingId) { stats.skipped += 1; continue; }
            if (classifyMeetingStatus(meeting) === 'cancelled') { stats.skipped += 1; continue; }
            const key = `post:${meeting.id}:${ae.hubspotOwnerId}`;
            if (!force && this.state.has(key)) { stats.skipped += 1; continue; }
            const endMs = meetingEndMs(meeting);
            if (!force && (!endMs || now.getTime() < endMs + this.config.postMeetingDelayMin * 60 * 1000)) { stats.skipped += 1; continue; }
            const grain = await this.fetchGrainForMeeting(ae, meeting).catch(err => {
              this.logger.warn(`Sales admin Grain match failed for meeting ${meeting.id}: ${err.message}`);
              return { recording: null, grainUrl: '', source: 'grain_error' };
            });
            const extraction = await extractNextSteps({ anthropic: this.anthropic, recording: grain.recording, logger: this.logger });
            const promptRecord = {
              type: 'post',
              ae,
              meeting,
              meetingId: meeting.id,
              grainRecordingId: getGrainRecordingId(grain.recording),
              grainUrl: grain.grainUrl,
              extraction,
              stageDecision: await this.buildStageDecisionForMeeting(meeting),
              status: 'pending',
            };
            this.state.set(key, promptRecord);
            const posted = await this.safePostMessage(ae, {
              text: `Post-meeting check: ${meetingTitle(meeting)}`,
              blocks: buildPostMeetingBlocks({ ae, meeting, hubspot: this.hubspot, extraction, promptKey: key, grainUrl: grain.grainUrl, stageDecision: promptRecord.stageDecision }),
            });
            this.state.update(key, { slackTs: posted.ts, slackChannel: posted.channel || this.channelFor(ae), status: 'prompted' });
            stats.prompted += 1;
          }
        } catch (err) {
          stats.errors += 1;
          this.logger.error(`Sales admin post-meeting scan failed for ${ae.name}: ${err.message}`);
        }
      }
      return stats;
    });
  }

  async buildStageDecisionForMeeting(meeting) {
    const deal = primaryDeal(meeting);
    if (!deal?.id || !deal.pipeline) return null;
    const stages = await this.hubspot.getDealPipelineStages(deal.pipeline).catch(err => {
      this.logger.warn(`Sales admin pipeline stage fetch failed for deal ${deal.id}: ${err.message}`);
      return [];
    });
    return buildStageDecision({ deal, stages });
  }

  async applySelectedStage(record, selectedStageId) {
    const stageDecision = record.stageDecision;
    if (!stageDecision || !selectedStageId) return { updated: false, reason: 'No deal stage selected.' };
    const selectedLabel = selectedStageLabel(stageDecision, selectedStageId) || selectedStageId;
    if (selectedStageId === stageDecision.currentStageId) {
      return { updated: false, reason: `Deal stayed in ${stageDecision.currentStageLabel}.`, fromLabel: stageDecision.currentStageLabel, toLabel: selectedLabel };
    }
    await this.hubspot.updateDealStage(stageDecision.dealId, selectedStageId);
    return { updated: true, dealId: stageDecision.dealId, fromStageId: stageDecision.currentStageId, toStageId: selectedStageId, fromLabel: stageDecision.currentStageLabel, toLabel: selectedLabel };
  }

  async writeMeetingOutcome(promptKey, { status, editedOutcome = '', editedNextSteps = '', selectedStageId = '', slackUserId = '', responseChannel = '', responseThreadTs = '' } = {}) {
    const record = this.state.get(promptKey);
    if (!record) throw new Error(`Sales admin prompt state not found: ${promptKey}`);
    if (record.writebackStatus === 'written') return record;
    const meeting = record.meeting;
    const ae = record.ae;
    const effectiveStageId = status === 'no_show' ? '' : (selectedStageId || record.stageDecision?.recommendedStageId || '');
    const stageUpdate = status === 'no_show' ? { updated: false, reason: 'No-show confirmation does not move deal stage.' } : await this.applySelectedStage(record, effectiveStageId);
    const body = buildWritebackNote({
      ae,
      meeting,
      status,
      extraction: record.extraction,
      grainUrl: record.grainUrl,
      editedOutcome,
      editedNextSteps,
      stageDecision: record.stageDecision,
      selectedStageId: effectiveStageId,
      stageUpdate,
    });
    const note = await this.hubspot.createNote({
      body: `${body}\nConfirmed by Slack user: ${slackUserId || 'unknown'}`,
      meeting,
      contacts: meeting._contacts || [],
      companies: meeting._companies || [],
      deals: meeting._deals || [],
    });
    const taskIds = [];
    if (this.config.createTasks && status !== 'no_show') {
      const steps = editedNextSteps
        ? editedNextSteps.split(/\n+/).map(text => ({ text: text.trim() })).filter(step => step.text)
        : (record.extraction?.nextSteps || []);
      for (const step of steps.slice(0, 5)) {
        const task = await this.hubspot.createTask({
          subject: `Follow up: ${meetingTitle(meeting)}`.slice(0, 250),
          body: step.text,
          dueDate: step.dueDate,
          ownerId: ae.hubspotOwnerId,
          meeting,
          contacts: meeting._contacts || [],
          companies: meeting._companies || [],
          deals: meeting._deals || [],
        });
        taskIds.push(task.id);
      }
    }
    const updated = this.state.update(promptKey, {
      confirmationStatus: status,
      editedOutcome,
      editedNextSteps,
      confirmedBySlackUser: slackUserId,
      hubspotNoteId: note.id,
      hubspotTaskIds: taskIds,
      selectedStageId: effectiveStageId,
      stageUpdate,
      writebackStatus: 'written',
      status: status === 'no_show' ? 'no_show' : 'confirmed',
    });
    const channel = responseChannel || record.slackChannel;
    const threadTs = responseThreadTs || record.slackTs;
    if (channel && threadTs) {
      await this.app.client.chat.postMessage({
        token: this.env.SLACK_BOT_TOKEN,
        channel,
        thread_ts: threadTs,
        text: `Recorded in HubSpot. Note ID: ${note.id}${stageUpdate?.updated ? `; deal moved to ${stageUpdate.toLabel}` : ''}${taskIds.length ? `; tasks: ${taskIds.join(', ')}` : ''}`,
      }).catch(err => this.logger.warn(`Sales admin confirmation Slack reply failed: ${err.message}`));
    }
    return updated;
  }

  registerHandlers() {
    if (!this.app?.action || !this.app?.view) return;
    this.app.action(POST_ACTIONS.confirm, async ({ ack, body, action, client }) => {
      await ack();
      try {
        await this.writeMeetingOutcome(action.value, {
          status: 'confirmed',
          selectedStageId: selectedStageFromInteraction(body),
          slackUserId: body.user?.id,
          responseChannel: body.channel?.id || body.container?.channel_id,
          responseThreadTs: body.message?.ts || body.container?.message_ts,
        });
      } catch (err) {
        await client.chat.postMessage({ token: this.env.SLACK_BOT_TOKEN, channel: body.channel?.id || body.container?.channel_id, thread_ts: body.message?.ts || body.container?.message_ts, text: `Sales admin HubSpot write failed: ${err.message}` });
      }
    });

    this.app.action(POST_ACTIONS.noShow, async ({ ack, body, action, client }) => {
      await ack();
      try {
        await this.writeMeetingOutcome(action.value, {
          status: 'no_show',
          slackUserId: body.user?.id,
          responseChannel: body.channel?.id || body.container?.channel_id,
          responseThreadTs: body.message?.ts || body.container?.message_ts,
        });
      } catch (err) {
        await client.chat.postMessage({ token: this.env.SLACK_BOT_TOKEN, channel: body.channel?.id || body.container?.channel_id, thread_ts: body.message?.ts || body.container?.message_ts, text: `Sales admin no-show write failed: ${err.message}` });
      }
    });

    this.app.action(POST_ACTIONS.stageSelect, async ({ ack }) => {
      await ack();
    });

    this.app.action(POST_ACTIONS.ignore, async ({ ack, body, action, client }) => {
      await ack();
      const promptKey = action.value || action.selected_option?.value || '';
      this.state.update(promptKey, { status: 'ignored', ignoredBySlackUser: body.user?.id });
      await client.chat.postMessage({ token: this.env.SLACK_BOT_TOKEN, channel: body.channel?.id || body.container?.channel_id, thread_ts: body.message?.ts || body.container?.message_ts, text: 'Marked as not this meeting. Nothing was written to HubSpot.' });
    });

    this.app.action(POST_ACTIONS.edit, async ({ ack, body, action, client }) => {
      const record = this.state.get(action.value);
      if (!record) {
        await ack();
        await client.chat.postMessage({ token: this.env.SLACK_BOT_TOKEN, channel: body.channel?.id || body.container?.channel_id, thread_ts: body.message?.ts || body.container?.message_ts, text: `Sales admin prompt state not found: ${action.value}` });
        return;
      }
      const selectedStageId = selectedStageFromInteraction(body, record.stageDecision?.recommendedStageId || '');
      const openModal = client.views.open({
        token: this.env.SLACK_BOT_TOKEN,
        trigger_id: body.trigger_id,
        view: {
          type: 'modal',
          callback_id: POST_ACTIONS.editSubmit,
          private_metadata: JSON.stringify({ promptKey: action.value, channel: body.channel?.id || body.container?.channel_id, threadTs: body.message?.ts || body.container?.message_ts }),
          title: { type: 'plain_text', text: 'Edit next steps' },
          submit: { type: 'plain_text', text: 'Save to HubSpot' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [
            { type: 'input', block_id: 'outcome', label: { type: 'plain_text', text: 'Outcome' }, element: inputElement(record.extraction?.outcome || '') },
            { type: 'input', block_id: 'next_steps', label: { type: 'plain_text', text: 'Next steps' }, element: inputElement((record.extraction?.nextSteps || []).map(step => step.text).join('\n')) },
            ...(record.stageDecision ? [{ type: 'input', block_id: 'deal_stage', label: { type: 'plain_text', text: 'Confirm deal stage' }, element: stageSelectElement(record.stageDecision, selectedStageId) }] : []),
          ],
        },
      }).catch(async (err) => {
        await client.chat.postMessage({ token: this.env.SLACK_BOT_TOKEN, channel: body.channel?.id || body.container?.channel_id, thread_ts: body.message?.ts || body.container?.message_ts, text: `Sales admin edit modal failed to open: ${err.message}` }).catch(() => {});
        throw err;
      });
      await ack();
      await openModal;
    });

    this.app.view(POST_ACTIONS.editSubmit, async ({ ack, body, view }) => {
      await ack();
      const metadata = JSON.parse(view.private_metadata || '{}');
      const values = view.state?.values || {};
      const editedOutcome = values.outcome?.value?.value || '';
      const editedNextSteps = values.next_steps?.value?.value || '';
      const selectedStageId = values.deal_stage?.[POST_ACTIONS.stageSelect]?.selected_option?.value || '';
      try {
        await this.writeMeetingOutcome(metadata.promptKey, {
          status: 'edited',
          editedOutcome,
          editedNextSteps,
          selectedStageId,
          slackUserId: body.user?.id,
          responseChannel: metadata.channel,
          responseThreadTs: metadata.threadTs,
        });
      } catch (err) {
        this.logger.error(`Sales admin edit submit write failed: ${err.message}`);
        if (metadata.channel) {
          await this.app.client.chat.postMessage({ token: this.env.SLACK_BOT_TOKEN, channel: metadata.channel, thread_ts: metadata.threadTs, text: `Sales admin edit write failed: ${err.message}` }).catch(() => {});
        }
      }
    });
  }
}

function msUntilNextLocalTime({ now = new Date(), timeZone, hour, minute }) {
  const parts = getLocalDateParts(now, timeZone);
  let target = zonedLocalToUtc(parts.year, parts.month, parts.day, hour, minute, 0, timeZone);
  if (target <= now) {
    const nextUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 12, 0, 0));
    const nextParts = getLocalDateParts(nextUtc, timeZone);
    target = zonedLocalToUtc(nextParts.year, nextParts.month, nextParts.day, hour, minute, 0, timeZone);
  }
  return target.getTime() - now.getTime();
}

function scheduleSalesAdminWorkflow(workflow) {
  if (!workflow.isEnabled()) {
    workflow.logger.log('  Sales admin: disabled');
    return [];
  }
  const timers = [];
  const scheduleMorning = () => {
    const delay = msUntilNextLocalTime({ timeZone: workflow.config.timezone, hour: workflow.config.morningHour, minute: workflow.config.morningMinute });
    timers.push(setTimeout(async () => {
      await workflow.runMorningSummaries().catch(err => workflow.logger.error(`Sales admin morning scheduled run failed: ${err.message}`));
      scheduleMorning();
    }, delay));
    workflow.logger.log(`  Sales admin morning scheduled in ${Math.round(delay / 60000)} min`);
  };
  scheduleMorning();
  timers.push(setInterval(() => workflow.runCancellationScan().catch(err => workflow.logger.error(`Sales admin cancellation scheduled run failed: ${err.message}`)), workflow.config.cancelScanMin * 60 * 1000));
  timers.push(setInterval(() => workflow.runPostMeetingScan().catch(err => workflow.logger.error(`Sales admin post-meeting scheduled run failed: ${err.message}`)), workflow.config.scanIntervalMin * 60 * 1000));
  return timers;
}

function createSalesAdminWorkflow(deps) {
  return new SalesAdminWorkflow(deps);
}

module.exports = {
  DEFAULT_AE_ROSTER,
  POST_ACTIONS,
  SalesAdminWorkflow,
  buildConfig,
  buildWritebackNote,
  cancellationSourceLabel,
  classifyMeetingStatus,
  createSalesAdminWorkflow,
  extractNextSteps,
  getLocalDayRange,
  buildStageDecision,
  meetingEndMs,
  msUntilNextLocalTime,
  parseRoster,
  recordingDirectlyMatchesMeeting,
  resolveChannelId,
  selectedStageFromInteraction,
  scheduleSalesAdminWorkflow,
};
