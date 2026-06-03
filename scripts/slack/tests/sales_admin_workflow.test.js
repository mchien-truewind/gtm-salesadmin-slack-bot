const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const {
  DEFAULT_AE_ROSTER,
  buildConfig,
  buildStageDecision,
  buildWritebackNote,
  SalesAdminWorkflow,
  cancellationSourceLabel,
  classifyMeetingStatus,
  getLocalDayRange,
  meetingEndMs,
  msUntilNextLocalTime,
  parseRoster,
  recordingDirectlyMatchesMeeting,
  resolveChannelId,
  selectedStageFromInteraction,
} = require('../sales_admin/workflow');
const { createSalesAdminState } = require('../sales_admin/state');

function meeting(properties = {}) {
  return { id: 'm1', properties };
}

const STAGES = [
  { id: '1307720553', label: 'Stage 1: MQL', displayOrder: 0 },
  { id: '190380582', label: 'Stage 2: SQL (Full Product Demo)', displayOrder: 1 },
  { id: '190380583', label: 'Stage 3: Awaiting Materials', displayOrder: 2 },
  { id: '190380586', label: 'Stage 4: POC', displayOrder: 3 },
  { id: '190380584', label: 'Stage 5: Proposal', displayOrder: 4 },
  { id: '1166230571', label: 'Stage 6: Won', displayOrder: 5 },
  { id: '190380587', label: 'Stage 7: Closed/Lost', displayOrder: 6 },
];

test('sales admin cancellation detection handles CalendarSync, Calendly, and outcome fallbacks', () => {
  assert.equal(classifyMeetingStatus(meeting({ hs_meeting_title: 'Canceled: Anthony and Xavier' })), 'cancelled');
  assert.equal(classifyMeetingStatus(meeting({ hs_meeting_title: '[Canceled] Calendly: Intro to Truewind' })), 'cancelled');
  assert.equal(classifyMeetingStatus(meeting({ hs_meeting_title: 'Intro to Truewind', hs_meeting_outcome: 'CANCELED' })), 'cancelled');
  assert.equal(classifyMeetingStatus(meeting({ hs_meeting_title: 'Intro to Truewind' })), 'scheduled');
});

test('sales admin cancellation source labeling distinguishes CalendarSync and Calendly', () => {
  assert.equal(cancellationSourceLabel(meeting({ hs_meeting_source: 'BIDIRECTIONAL_SYNC', hs_object_source_id: 'CalendarSync' })), 'CalendarSync');
  assert.equal(cancellationSourceLabel(meeting({ hs_object_source_detail_1: 'Calendly', hs_object_source_id: '199720' })), 'Calendly');
  assert.equal(cancellationSourceLabel(meeting({ hs_meeting_title: '[Canceled] Calendly: Intro' })), 'Calendly');
  assert.equal(cancellationSourceLabel(meeting({ hs_meeting_title: 'Canceled: Unknown' })), 'Unknown');
});


test('sales admin Grain matching can use direct HubSpot and calendar metadata', () => {
  assert.equal(recordingDirectlyMatchesMeeting({ hubspot: { meeting_id: '12345' } }, { id: '12345', properties: {} }), true);
  assert.equal(recordingDirectlyMatchesMeeting({ calendar_event: { id: 'calendar-event-1' } }, meeting({ hs_meeting_source_id: 'calendar-event-1' })), true);
  assert.equal(recordingDirectlyMatchesMeeting({ calendar_event: { id: 'other' } }, meeting({ hs_meeting_source_id: 'calendar-event-1' })), false);
});

test('sales admin roster requires channel, Slack user, and HubSpot owner', () => {
  const roster = parseRoster(JSON.stringify([{ name: 'Alex Lee', hubspotOwnerId: '60918610', email: 'alex@trytruewind.com', slackUserId: 'U04BPMPR29G', salesAdminChannel: '#gtm-salesadmin-alex' }]));
  assert.deepEqual(roster, [{ name: 'Alex Lee', hubspotOwnerId: '60918610', email: 'alex@trytruewind.com', slackUserId: 'U04BPMPR29G', salesAdminChannel: 'gtm-salesadmin-alex' }]);
  assert.throws(() => parseRoster(JSON.stringify([{ name: 'Missing Channel', hubspotOwnerId: '1', email: 'a@example.com', slackUserId: 'U1' }])), /salesAdminChannel/);
});

test('sales admin default roster includes confirmed Alex and Amy IDs', () => {
  const byName = Object.fromEntries(DEFAULT_AE_ROSTER.map(ae => [ae.name, ae]));
  assert.equal(byName['Alex Lee'].hubspotOwnerId, '60918610');
  assert.equal(byName['Alex Lee'].slackUserId, 'U04BPMPR29G');
  assert.equal(byName['Amy Vetter'].hubspotOwnerId, '92555980');
  assert.equal(byName['Amy Vetter'].slackUserId, 'U0B4MRN83FE');
});


test('sales admin stage decision defaults to next stage and includes current plus later stages', () => {
  const decision = buildStageDecision({
    deal: { id: 'deal-1', dealname: 'Acme', pipeline: '105321581', dealstage: '190380582' },
    stages: STAGES,
  });

  assert.equal(decision.currentStageLabel, 'Stage 2: SQL (Full Product Demo)');
  assert.equal(decision.recommendedStageId, '190380583');
  assert.equal(decision.recommendedStageLabel, 'Stage 3: Awaiting Materials');
  assert.deepEqual(decision.options.map(stage => stage.id), ['190380582', '190380583', '190380586', '190380584', '1166230571', '190380587']);
});

test('sales admin stage decision stays on final stage when already terminal', () => {
  const decision = buildStageDecision({
    deal: { id: 'deal-1', dealname: 'Acme', pipeline: '105321581', dealstage: '190380587' },
    stages: STAGES,
  });

  assert.equal(decision.currentStageLabel, 'Stage 7: Closed/Lost');
  assert.equal(decision.recommendedStageId, '190380587');
  assert.deepEqual(decision.options.map(stage => stage.id), ['190380587']);
});

test('sales admin reads selected stage from Slack interaction state', () => {
  assert.equal(selectedStageFromInteraction({
    state: {
      values: {
        deal_stage: {
          sales_admin_stage_select: {
            action_id: 'sales_admin_stage_select',
            selected_option: { value: '190380583' },
          },
        },
      },
    },
  }), '190380583');
  assert.equal(selectedStageFromInteraction({ state: { values: {} } }, 'fallback'), 'fallback');
});

test('sales admin config defaults disabled and channel roster is available', () => {
  const config = buildConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.postMeetingDelayMin, 10);
  assert.equal(config.cancelScanMin, 5);
  assert.equal(config.tomorrowHour, 17);
  assert.equal(config.tomorrowMinute, 0);
  assert.ok(config.roster.some(ae => ae.salesAdminChannel === 'gtm-salesadmin-sarah'));
});

test('sales admin Pacific day range respects date key', () => {
  const range = getLocalDayRange(new Date('2026-06-03T18:00:00.000Z'), 'America/Los_Angeles');
  assert.equal(range.dateKey, '2026-06-03');
  assert.equal(range.start.toISOString(), '2026-06-03T07:00:00.000Z');
  assert.equal(range.end.toISOString(), '2026-06-04T07:00:00.000Z');
});

test('sales admin Pacific day range supports tomorrow offset', () => {
  const range = getLocalDayRange(new Date('2026-06-03T18:00:00.000Z'), 'America/Los_Angeles', 1);
  assert.equal(range.dateKey, '2026-06-04');
  assert.equal(range.start.toISOString(), '2026-06-04T07:00:00.000Z');
  assert.equal(range.end.toISOString(), '2026-06-05T07:00:00.000Z');
});

test('sales admin meeting end falls back to one hour after start', () => {
  assert.equal(meetingEndMs(meeting({ hs_meeting_start_time: '2026-06-03T18:00:00.000Z' })), Date.parse('2026-06-03T19:00:00.000Z'));
  assert.equal(meetingEndMs(meeting({ hs_meeting_end_time: '2026-06-03T18:30:00.000Z' })), Date.parse('2026-06-03T18:30:00.000Z'));
});

test('sales admin next local time schedules tomorrow after target', () => {
  const delay = msUntilNextLocalTime({ now: new Date('2026-06-03T16:00:00.000Z'), timeZone: 'America/Los_Angeles', hour: 8, minute: 0 });
  assert.equal(delay, 23 * 60 * 60 * 1000);
});


test('sales admin skips configured AEs whose channel has not resolved', async () => {
  const posts = [];
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async payload => { posts.push(payload); return { ts: '1', channel: payload.channel }; } } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Sarah Elix', hubspotOwnerId: '84547076', email: 'sarah@trytruewind.com', slackUserId: 'U09QC3B292R', salesAdminChannel: 'gtm-salesadmin-sarah' },
        { name: 'Alex Lee', hubspotOwnerId: '60918610', email: 'alex@trytruewind.com', slackUserId: 'U04BPMPR29G', salesAdminChannel: 'gtm-salesadmin-alex' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-skip-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  workflow.channelIdsByOwnerId.set('84547076', 'C_SARAH');
  workflow.missingChannelsByOwnerId.add('60918610');
  workflow.meetingsForToday = async () => [];

  const stats = await workflow.runMorningSummaries(new Date('2026-06-03T18:00:00.000Z'));
  assert.equal(stats.posted, 1);
  assert.equal(stats.skipped, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, 'C_SARAH');
});

test('sales admin tomorrow summary posts next-day calls after 5pm schedule', async () => {
  const posts = [];
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async payload => { posts.push(payload); return { ts: '1', channel: payload.channel }; } } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Sarah Elix', hubspotOwnerId: '84547076', email: 'sarah@trytruewind.com', slackUserId: 'U09QC3B292R', salesAdminChannel: 'gtm-salesadmin-sarah' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-tomorrow-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  workflow.channelIdsByOwnerId.set('84547076', 'C_SARAH');
  workflow.meetingsForTomorrow = async () => [
    {
      id: 'm1',
      properties: { hs_meeting_title: 'Truewind Full Demo', hs_meeting_start_time: '2026-06-04T16:30:00.000Z' },
      _companies: [{ id: 'c1', name: 'Acme' }],
      _deals: [{ id: 'd1', dealname: 'Acme - New Deal' }],
      _contacts: [{ id: 'ct1', firstname: 'Ava', lastname: 'Buyer', email: 'ava@example.com' }],
    },
    {
      id: 'm2',
      properties: { hs_meeting_title: 'Canceled: Old Intro', hs_meeting_start_time: '2026-06-04T20:00:00.000Z' },
    },
  ];

  const stats = await workflow.runTomorrowSummaries(new Date('2026-06-03T18:00:00.000Z'));

  assert.equal(stats.posted, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, 'C_SARAH');
  assert.match(posts[0].text, /Tomorrow's calls .*Jun 4/);
  assert.match(posts[0].text, /<@U09QC3B292R>/);
  assert.match(posts[0].text, /\*9:30 AM — Acme\*/);
  assert.match(posts[0].text, /Truewind Full Demo/);
  assert.match(posts[0].text, /HubSpot meeting/);
  assert.match(posts[0].text, /Cancelled tomorrow/);
  assert.equal(workflow.state.get('tomorrow:2026-06-04:84547076').status, 'posted');
});

test('sales admin resolves public channels without requiring private channel scope', async () => {
  const calls = [];
  const channelId = await resolveChannelId({
    conversations: {
      list: async payload => {
        calls.push(payload);
        if (payload.types === 'private_channel') {
          const err = new Error('missing_scope');
          err.data = { error: 'missing_scope' };
          throw err;
        }
        return { channels: [{ id: 'C_SARAH', name: 'gtm-salesadmin-sarah' }] };
      },
    },
  }, 'xoxb-test', '#gtm-salesadmin-sarah');

  assert.equal(channelId, 'C_SARAH');
  assert.deepEqual(calls.map(call => call.types), ['public_channel']);
});

test('sales admin post-meeting scan can force a single targeted meeting', async () => {
  const posts = [];
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async payload => { posts.push(payload); return { ts: '1', channel: payload.channel }; } } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Sarah Elix', hubspotOwnerId: '84547076', email: 'sarah@trytruewind.com', slackUserId: 'U09QC3B292R', salesAdminChannel: 'gtm-salesadmin-sarah' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-target-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  workflow.channelIdsByOwnerId.set('84547076', 'C_SARAH');
  workflow.meetingsForToday = async () => [
    { id: 'skip-me', properties: { hs_meeting_title: 'Other call', hs_meeting_start_time: '2026-06-03T18:00:00Z', hs_meeting_end_time: '2026-06-03T18:30:00Z' } },
    { id: 'target-me', properties: { hs_meeting_title: 'EdOps / Truewind', hs_meeting_start_time: '2026-06-03T20:30:00Z', hs_meeting_end_time: '2026-06-03T21:30:00Z' } },
  ];
  workflow.fetchGrainForMeeting = async () => ({
    recording: { id: 'grain-1', title: 'EdOps / Truewind', ai_summary: { summary: 'EdOps is evaluating Truewind for finance workflow automation and needs a follow-up on implementation scope.' }, ai_action_items: [{ text: 'Send follow-up' }] },
    grainUrl: 'https://grain.com/share/recording/grain-1',
    source: 'grain_matched',
  });
  workflow.buildStageDecisionForMeeting = async () => buildStageDecision({
    deal: { id: 'deal-1', dealname: 'EdOps - New Deal', pipeline: '105321581', dealstage: '190380582' },
    stages: STAGES,
  });
  workflow.state.set('post:target-me:84547076', { status: 'previously_prompted' });

  const stats = await workflow.runPostMeetingScan(new Date('2026-06-03T22:00:00Z'), {
    ownerId: '84547076',
    meetingId: 'target-me',
    force: true,
  });

  assert.equal(stats.prompted, 1);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /EdOps/);
  assert.match(posts[0].blocks[0].text.text, /^\*EdOps \/ Truewind\*/);
  assert.match(posts[0].blocks[0].text.text, /Meeting completed; review next steps/);
  assert.ok(!posts[0].blocks.some(block => block.text?.text?.includes('*Outcome from Grain*')));
  assert.ok(posts[0].blocks.some(block => block.text?.text?.includes('*Suggested follow-up from Grain*')));
  const hubspotNextStepBlock = posts[0].blocks.find(block => block.text?.text?.includes('*HubSpot Next Step*'));
  assert.match(hubspotNextStepBlock.text.text, /saved to HubSpot under `Next step`/);
  assert.match(hubspotNextStepBlock.text.text, /EdOps is evaluating Truewind/);
  assert.ok(!posts[0].blocks.some(block => block.text?.text?.includes('```')));
  const stageBlock = posts[0].blocks.find(block => block.block_id === 'deal_stage');
  assert.match(stageBlock.text.text, /Deal stage: EdOps - New Deal/);
  assert.match(stageBlock.text.text, /Current stage: \*Stage 2: SQL/);
  assert.match(stageBlock.text.text, /Recommended: \*move it to Stage 3: Awaiting Materials/);
  assert.equal(stageBlock.accessory.type, 'static_select');
  assert.equal(stageBlock.accessory.initial_option.value, '190380583');
  assert.deepEqual(stageBlock.accessory.options.map(option => option.value), ['190380582', '190380583', '190380586', '190380584', '1166230571', '190380587']);
  const actions = posts[0].blocks.find(block => block.type === 'actions');
  assert.deepEqual(actions.elements.map(element => element.type === 'button' ? element.text.text : element.options[0].text.text), ['Confirm & Save', 'Edit Notes', 'No-Show', 'Not this meeting']);
  assert.equal(actions.elements[3].type, 'overflow');
  assert.equal(workflow.state.get('post:target-me:84547076').grainUrl, 'https://grain.com/share/recording/grain-1');
});

test('sales admin confirmation updates HubSpot deal next step summary', async () => {
  const propertyUpdates = [];
  const notes = [];
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async () => ({ ts: 'reply' }) } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Sarah Elix', hubspotOwnerId: '84547076', email: 'sarah@trytruewind.com', slackUserId: 'U09QC3B292R', salesAdminChannel: 'gtm-salesadmin-sarah' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-write-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  workflow.hubspot = {
    updateDealStage: async () => ({}),
    updateDealProperty: async (dealId, propertyName, value) => {
      propertyUpdates.push({ dealId, propertyName, value });
      return {};
    },
    createNote: async input => {
      notes.push(input.body);
      return { id: 'note-1' };
    },
    createTask: async () => ({ id: 'task-1' }),
  };
  const stageDecision = buildStageDecision({
    deal: { id: 'deal-1', dealname: 'Acme', pipeline: '105321581', dealstage: '190380582' },
    stages: STAGES,
  });
  workflow.state.set('post:m1:84547076', {
    ae: { name: 'Sarah Elix', email: 'sarah@trytruewind.com', hubspotOwnerId: '84547076' },
    meeting: { id: 'm1', properties: { hs_meeting_title: 'Intro', hs_meeting_start_time: '2026-06-03T18:00:00.000Z' }, _deals: [{ id: 'deal-1' }] },
    extraction: { summary: 'Acme is interested in AP automation and needs pricing follow-up.', nextSteps: [{ text: 'Send pricing' }] },
    grainUrl: 'https://grain.com/share/recording/grain-1',
    stageDecision,
    slackChannel: 'C_SARAH',
    slackTs: '1',
  });

  const updated = await workflow.writeMeetingOutcome('post:m1:84547076', {
    status: 'confirmed',
    selectedStageId: '190380582',
    slackUserId: 'U_TEST',
  });

  assert.deepEqual(propertyUpdates, [{ dealId: 'deal-1', propertyName: 'hs_next_step', value: 'Acme is interested in AP automation and needs pricing follow-up.' }]);
  assert.equal(updated.hubspotNextStep, 'Acme is interested in AP automation and needs pricing follow-up.');
  assert.equal(updated.nextStepPropertyUpdate.updated, true);
  assert.match(notes[0], /HubSpot Next step: Acme is interested/);
});

test('sales admin state persists idempotency records', () => {
  const file = path.join(os.tmpdir(), `sales-admin-state-${Date.now()}-${Math.random()}.json`);
  const state = createSalesAdminState(file, { error() {}, warn() {}, log() {} });
  state.set('cancel:m1:owner', { status: 'alerted' });
  const reloaded = createSalesAdminState(file, { error() {}, warn() {}, log() {} });
  assert.equal(reloaded.get('cancel:m1:owner').status, 'alerted');
});

test('sales admin writeback note separates cancellation/no-show from confirmed next steps', () => {
  const note = buildWritebackNote({
    ae: { name: 'Sarah Elix', email: 'sarah@trytruewind.com' },
    meeting: meeting({ hs_meeting_title: 'Intro', hs_meeting_start_time: '2026-06-03T18:00:00.000Z' }),
    status: 'no_show',
    extraction: { outcome: 'Meeting completed', nextSteps: [{ text: 'Send proposal' }] },
  });
  assert.match(note, /Status: no_show/);
  assert.match(note, /Outcome: No show/);
  assert.doesNotMatch(note, /Send proposal/);
  assert.doesNotMatch(note, /Confirmed deal stage:/);
});

test('sales admin writeback note records selected deal stage movement', () => {
  const stageDecision = buildStageDecision({
    deal: { id: 'deal-1', dealname: 'Acme', pipeline: '105321581', dealstage: '190380582' },
    stages: STAGES,
  });
  const note = buildWritebackNote({
    ae: { name: 'Sarah Elix', email: 'sarah@trytruewind.com' },
    meeting: meeting({ hs_meeting_title: 'Intro', hs_meeting_start_time: '2026-06-03T18:00:00.000Z' }),
    status: 'confirmed',
    extraction: { outcome: 'Meeting completed', summary: 'Prospect is ready for proposal follow-up.', nextSteps: [{ text: 'Send proposal' }] },
    hubspotNextStep: 'Prospect is ready for proposal follow-up.',
    stageDecision,
    selectedStageId: '190380583',
    stageUpdate: { updated: true, fromLabel: 'Stage 2: SQL (Full Product Demo)', toLabel: 'Stage 3: Awaiting Materials' },
  });
  assert.match(note, /Deal stage before confirmation: Stage 2/);
  assert.match(note, /Confirmed deal stage: Stage 3: Awaiting Materials/);
  assert.match(note, /Deal stage updated in HubSpot: Stage 2: SQL \(Full Product Demo\) -> Stage 3: Awaiting Materials/);
  assert.match(note, /HubSpot Next step: Prospect is ready for proposal follow-up/);
});
