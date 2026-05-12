const assert = require('assert');

process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'xoxb-test';
process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || 'test-secret';
process.env.SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || 'xapp-test';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-secret';
process.env.GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || 'test-refresh';
process.env.SLACK_TO_HUBSPOT_OWNER_JSON = JSON.stringify({
  U_TEST: { id: '89305622', name: 'Xavier Marco' },
});

const {
  TRUEWIND_HUBSPOT,
  deduceLeadSource,
  executeTool,
  hubspotPropertyCache,
  isHubSpotWriteAuthorized,
  isReadOnlyHubSpotProperty,
  resolveHubSpotOwner,
  resolveHubSpotOwnerForProspect,
  validateHubSpotProperties,
} = require('../slack_bot');

function seedHubSpotProperty(objectType, name, overrides = {}) {
  hubspotPropertyCache.set(`${objectType}:${name}`, {
    name,
    readOnlyValue: false,
    calculated: false,
    options: [],
    ...overrides,
  });
}

async function testConvertedLeadStatusUsesInternalValue() {
  assert.strictEqual(TRUEWIND_HUBSPOT.convertedLeadStatus, 'MQL');
  seedHubSpotProperty('contacts', 'hs_lead_status', {
    options: [
      { label: 'Converted', value: 'MQL' },
      { label: 'No one has contacted them', value: 'No one has contacted them' },
    ],
  });

  assert.deepStrictEqual(
    await validateHubSpotProperties('contacts', { hs_lead_status: 'Converted' }),
    { hs_lead_status: 'MQL' },
  );
}

async function testReadOnlyDealPropertiesAreRejectedBeforeWrite() {
  seedHubSpotProperty('deals', 'hs_deal_stage_probability_shadow', {
    modificationMetadata: { readOnlyValue: true },
  });
  assert.strictEqual(
    isReadOnlyHubSpotProperty({ modificationMetadata: { readOnlyValue: true } }),
    true,
  );

  const result = await executeTool('hubspot_update_deal', {
    deal_id: '123',
    properties: { hs_deal_stage_probability_shadow: '0.5' },
  });

  assert.match(result, /read-only/);
  assert.match(result, /hs_deal_stage_probability_shadow/);
}

async function testExplicitOwnerOverridesSlackMapping() {
  const owner = resolveHubSpotOwner({ slack_user_id: 'U_TEST', owner_name: 'Mercedes' });
  assert.deepStrictEqual(owner, { id: '87811681', name: 'Mercedes Chien', source: 'explicit owner' });
  assert.deepStrictEqual(
    await resolveHubSpotOwnerForProspect({ slack_user_id: 'U_TEST', owner_name: 'Mercedes' }),
    { id: '87811681', name: 'Mercedes Chien', source: 'explicit owner' },
  );
  assert.deepStrictEqual(
    isHubSpotWriteAuthorized({ slack_user_id: 'U_TEST' }, owner),
    { authorized: true, reason: 'Slack user maps to HubSpot owner' },
  );
  assert.strictEqual(
    isHubSpotWriteAuthorized({ slack_user_id: 'U_UNMAPPED' }, owner).authorized,
    false,
  );
}

function testLeadSourceDefaultsToOutbound() {
  assert.strictEqual(deduceLeadSource('please create this outbound deal'), 'Outbound - Sales Sourced List');
  assert.strictEqual(deduceLeadSource(''), 'Outbound - Sales Sourced List');
}

async function run() {
  await testConvertedLeadStatusUsesInternalValue();
  await testReadOnlyDealPropertiesAreRejectedBeforeWrite();
  await testExplicitOwnerOverridesSlackMapping();
  testLeadSourceDefaultsToOutbound();
}

run()
  .then(() => console.log('slack_bot_hubspot tests passed'))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
