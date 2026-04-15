const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDiscoveryDigestConfig,
  dedupeDigestMeetings,
  findBestGrainRecordingForMeeting,
  formatEmptyDiscoveryDigestMessage,
  formatGrainTranscriptText,
  getGrainRecordingStartMs,
  getGrainRecordingUrl,
  isLikelyGrainDiscoveryRecording,
  isLikelyHubSpotDiscoveryMeeting,
  parseListItems,
} = require('../discovery_digest');

test('HubSpot discovery classification uses owner scope, include terms, and exclusions', () => {
  const config = buildDiscoveryDigestConfig({
    DISCOVERY_DIGEST_SALES_OWNER_IDS: '42',
    DISCOVERY_DIGEST_INTERNAL_DOMAINS: 'trytruewind.com',
  });

  assert.equal(isLikelyHubSpotDiscoveryMeeting({
    properties: {
      hubspot_owner_id: '42',
      hs_meeting_title: 'Discovery call with Acme',
      hs_meeting_body: '',
    },
    _externalContacts: [{ email: 'cfo@acme.com' }],
  }, config), true);

  assert.equal(isLikelyHubSpotDiscoveryMeeting({
    properties: {
      hubspot_owner_id: '99',
      hs_meeting_title: 'Discovery call with Acme',
      hs_meeting_body: '',
    },
    _externalContacts: [{ email: 'cfo@acme.com' }],
  }, config), false);

  assert.equal(isLikelyHubSpotDiscoveryMeeting({
    properties: {
      hubspot_owner_id: '42',
      hs_meeting_title: 'Demo with Acme',
      hs_meeting_body: '',
    },
    _externalContacts: [{ email: 'cfo@acme.com' }],
  }, config), false);
});

test('HubSpot discovery classification supports fetched owner email scope', () => {
  const config = buildDiscoveryDigestConfig({
    DISCOVERY_DIGEST_SALES_EMAILS: 'seller@trytruewind.com',
    DISCOVERY_DIGEST_INTERNAL_DOMAINS: 'trytruewind.com',
  });

  assert.equal(isLikelyHubSpotDiscoveryMeeting({
    properties: {
      hubspot_owner_email: 'seller@trytruewind.com',
      hs_meeting_title: 'Discovery call with Acme',
      hs_meeting_body: '',
    },
    _externalContacts: [{ email: 'cfo@acme.com' }],
  }, config), true);
});

test('Grain discovery classification requires sales scope and an external participant', () => {
  const config = buildDiscoveryDigestConfig({
    DISCOVERY_DIGEST_SALES_EMAILS: 'sarah@trytruewind.com',
    DISCOVERY_DIGEST_INTERNAL_DOMAINS: 'trytruewind.com',
  });

  assert.equal(isLikelyGrainDiscoveryRecording({
    id: 'grain_1',
    title: 'Intro / Discovery with Acme',
    participants: [
      { email: 'sarah@trytruewind.com' },
      { email: 'controller@acme.com' },
    ],
  }, config), true);

  assert.equal(isLikelyGrainDiscoveryRecording({
    id: 'grain_2',
    title: 'Intro / Discovery internal prep',
    participants: [
      { email: 'sarah@trytruewind.com' },
      { email: 'alex@trytruewind.com' },
    ],
  }, config), false);
});

test('Grain discovery classification supports owner email arrays from public API', () => {
  const config = buildDiscoveryDigestConfig({
    DISCOVERY_DIGEST_SALES_EMAILS: 'seller@trytruewind.com',
    DISCOVERY_DIGEST_INTERNAL_DOMAINS: 'trytruewind.com',
  });

  assert.equal(isLikelyGrainDiscoveryRecording({
    id: 'grain_3',
    title: 'Intro with Acme',
    owners: ['seller@trytruewind.com'],
    participants: [{ email: 'buyer@acme.com' }],
  }, config), true);
});

test('Grain matching prefers participant email overlap over nearest unrelated recording', () => {
  const config = buildDiscoveryDigestConfig({
    DISCOVERY_DIGEST_MATCH_WINDOW_MINUTES: '60',
  });
  const meeting = {
    properties: {
      hs_meeting_title: 'Discovery call with Acme',
      hs_meeting_start_time: '2026-04-13T17:00:00.000Z',
    },
    _externalContacts: [{ email: 'cfo@acme.com' }],
  };

  const matched = findBestGrainRecordingForMeeting(meeting, [
    {
      id: 'near_wrong',
      title: 'Discovery call with Other',
      start_time: '2026-04-13T17:01:00.000Z',
      participants: [{ email: 'buyer@other.com' }],
    },
    {
      id: 'right_email',
      title: 'Intro / Discovery with Acme',
      start_time: '2026-04-13T17:25:00.000Z',
      participants: [{ email: 'cfo@acme.com' }],
    },
  ], config);

  assert.equal(matched.id, 'right_email');
});

test('transcript formatting handles Grain turn arrays', () => {
  assert.equal(formatGrainTranscriptText({
    transcript: [
      { speaker_name: 'Pat', text: 'We need better close visibility.' },
      { speaker: { name: 'Sam' }, content: 'Tell me more.' },
    ],
  }), 'Pat: We need better close visibility.\nSam: Tell me more.');
});

test('Grain recording helpers handle current public API field names', () => {
  assert.equal(getGrainRecordingStartMs({
    start_datetime: '2026-04-13T17:00:00.000Z',
  }), Date.parse('2026-04-13T17:00:00.000Z'));

  assert.equal(getGrainRecordingUrl({
    public_url: 'https://grain.com/share/example',
    url: 'https://api.grain.com/_/public-api/recordings/example',
  }), 'https://grain.com/share/example');
});

test('dedupe prefers Grain recording identity and list parser handles common shapes', () => {
  const deduped = dedupeDigestMeetings([
    { _grainId: 'abc', properties: { hs_meeting_title: 'Discovery' } },
    { _grainId: 'abc', properties: { hs_meeting_title: 'Discovery duplicate' } },
  ]);
  assert.equal(deduped.length, 1);

  assert.deepEqual(parseListItems({ recordings: [{ id: '1' }], next_cursor: 'next' }), {
    items: [{ id: '1' }],
    cursor: 'next',
    hasMore: true,
  });
});

test('empty discovery digest copy uses the digest date label, not yesterday', () => {
  assert.equal(
    formatEmptyDiscoveryDigestMessage('Wednesday, Apr 15, 2026'),
    '*Discovery Call Digest -- Wednesday, Apr 15, 2026*\n\nNo discovery calls were scheduled for Wednesday, Apr 15, 2026.',
  );
});
