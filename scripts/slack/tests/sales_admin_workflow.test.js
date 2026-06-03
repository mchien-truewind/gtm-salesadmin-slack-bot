const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const {
  DEFAULT_AE_ROSTER,
  buildConfig,
  buildWritebackNote,
  cancellationSourceLabel,
  classifyMeetingStatus,
  getLocalDayRange,
  meetingEndMs,
  msUntilNextLocalTime,
  parseRoster,
  recordingDirectlyMatchesMeeting,
} = require('../sales_admin/workflow');
const { createSalesAdminState } = require('../sales_admin/state');

function meeting(properties = {}) {
  return { id: 'm1', properties };
}

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

test('sales admin config defaults disabled and channel roster is available', () => {
  const config = buildConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.postMeetingDelayMin, 10);
  assert.equal(config.cancelScanMin, 5);
  assert.ok(config.roster.some(ae => ae.salesAdminChannel === 'gtm-salesadmin-sarah'));
});

test('sales admin Pacific day range respects date key', () => {
  const range = getLocalDayRange(new Date('2026-06-03T18:00:00.000Z'), 'America/Los_Angeles');
  assert.equal(range.dateKey, '2026-06-03');
  assert.equal(range.start.toISOString(), '2026-06-03T07:00:00.000Z');
  assert.equal(range.end.toISOString(), '2026-06-04T07:00:00.000Z');
});

test('sales admin meeting end falls back to one hour after start', () => {
  assert.equal(meetingEndMs(meeting({ hs_meeting_start_time: '2026-06-03T18:00:00.000Z' })), Date.parse('2026-06-03T19:00:00.000Z'));
  assert.equal(meetingEndMs(meeting({ hs_meeting_end_time: '2026-06-03T18:30:00.000Z' })), Date.parse('2026-06-03T18:30:00.000Z'));
});

test('sales admin next local time schedules tomorrow after target', () => {
  const delay = msUntilNextLocalTime({ now: new Date('2026-06-03T16:00:00.000Z'), timeZone: 'America/Los_Angeles', hour: 8, minute: 0 });
  assert.equal(delay, 23 * 60 * 60 * 1000);
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
});
