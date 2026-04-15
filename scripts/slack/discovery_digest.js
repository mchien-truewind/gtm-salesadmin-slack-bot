const DEFAULT_INTERNAL_DOMAINS = ['trytruewind.com'];
const DEFAULT_DISCOVERY_TERMS = [
  'intro',
  'introduction',
  'discovery',
  'disco',
  'qualification',
  'qualified',
  'booked calendly meeting',
  'new meeting',
];
const DEFAULT_EXCLUDE_TERMS = [
  'retro',
  'role play',
  'check in',
  'check-in',
  'standup',
  'stand-up',
  'sync',
  '1:1',
  'team',
  'sprint',
  'metrics',
  'demo',
  'all hands',
  'follow up',
  'follow-up',
  'proposal',
  'review',
  'onboarding',
  'kickoff',
  'kick-off',
  'training',
  'internal',
  'weekly',
  'daily',
];

function normalizeDigestText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function parseSet(value) {
  return new Set(parseCsv(value).map(item => item.toLowerCase()));
}

function buildDiscoveryDigestConfig(env = process.env) {
  return {
    internalDomains: parseSet(env.DISCOVERY_DIGEST_INTERNAL_DOMAINS || DEFAULT_INTERNAL_DOMAINS.join(',')),
    salesEmails: parseSet(env.DISCOVERY_DIGEST_SALES_EMAILS || env.DISCOVERY_DIGEST_OWNER_EMAILS || ''),
    salesOwnerIds: parseSet(env.DISCOVERY_DIGEST_SALES_OWNER_IDS || env.DISCOVERY_DIGEST_OWNER_IDS || ''),
    includeTerms: parseCsv(env.DISCOVERY_DIGEST_INCLUDE_TERMS || DEFAULT_DISCOVERY_TERMS.join(',')).map(normalizeDigestText),
    excludeTerms: parseCsv(env.DISCOVERY_DIGEST_EXCLUDE_TERMS || DEFAULT_EXCLUDE_TERMS.join(',')).map(normalizeDigestText),
    matchWindowMs: Number(env.DISCOVERY_DIGEST_MATCH_WINDOW_MINUTES || 45) * 60 * 1000,
  };
}

function isInternalEmail(email, internalDomains) {
  const normalized = normalizeDigestText(email);
  const domain = normalized.includes('@') ? normalized.split('@').pop() : '';
  return !!domain && internalDomains.has(domain);
}

function hasExternalEmail(emails, internalDomains) {
  return emails.some(email => email && !isInternalEmail(email, internalDomains));
}

function getContactEmails(meeting) {
  return [
    ...(meeting?._contacts || []),
    ...(meeting?._externalContacts || []),
  ]
    .map(contact => normalizeDigestText(contact?.email))
    .filter(Boolean);
}

function getHubSpotMeetingText(meeting) {
  return normalizeDigestText([
    meeting?.properties?.hs_meeting_title,
    meeting?.properties?.hs_meeting_body,
  ].filter(Boolean).join(' '));
}

function isCanceledHubSpotMeeting(meeting) {
  return normalizeDigestText(meeting?.properties?.hs_meeting_title).startsWith('canceled:');
}

function isSalesOwnedHubSpotMeeting(meeting, config) {
  const ownerId = normalizeDigestText(meeting?.properties?.hubspot_owner_id);
  if (config.salesOwnerIds.size > 0 && ownerId && config.salesOwnerIds.has(ownerId)) return true;

  const ownerEmail = normalizeDigestText(meeting?.properties?.hubspot_owner_email);
  if (config.salesEmails.size > 0 && ownerEmail && config.salesEmails.has(ownerEmail)) return true;

  if (config.salesEmails.size === 0 && config.salesOwnerIds.size === 0) return true;
  return false;
}

function isLikelyHubSpotDiscoveryMeeting(meeting, config) {
  if (!isSalesOwnedHubSpotMeeting(meeting, config)) return false;

  const text = getHubSpotMeetingText(meeting);
  if (!text) return false;
  if (config.excludeTerms.some(term => term && text.includes(term))) return false;
  if (isCanceledHubSpotMeeting(meeting)) {
    const contactEmails = getContactEmails(meeting);
    return config.includeTerms.some(term => term && text.includes(term))
      || hasExternalEmail(contactEmails, config.internalDomains);
  }
  return config.includeTerms.some(term => term && text.includes(term));
}

function getDigestMeetingStartMs(meeting) {
  const iso = meeting?.properties?.hs_meeting_start_time;
  const parsed = iso ? new Date(iso).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function getPrimaryDigestContact(meeting) {
  return (meeting?._externalContacts || [])[0] || (meeting?._contacts || [])[0] || null;
}

function getDigestContactKey(contact) {
  if (!contact) return '';
  const email = normalizeDigestText(contact.email);
  if (email) return email;
  const name = normalizeDigestText(`${contact.firstname || ''} ${contact.lastname || ''}`);
  const company = normalizeDigestText(contact.company);
  return [name, company].filter(Boolean).join('|');
}

function getDigestMeetingKey(meeting) {
  if (meeting?._grainId) return `grain:${meeting._grainId}`;
  const startMs = getDigestMeetingStartMs(meeting);
  const contactKey = getDigestContactKey(getPrimaryDigestContact(meeting));
  if (startMs && contactKey) return `hubspot-contact-time:${startMs}|${contactKey}`;
  const title = normalizeDigestText(meeting?.properties?.hs_meeting_title || meeting?.title);
  return `hubspot:${title}|${startMs}|${contactKey}`;
}

function dedupeDigestMeetings(meetings) {
  const seen = new Set();
  const deduped = [];
  for (const meeting of meetings) {
    const key = getDigestMeetingKey(meeting);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(meeting);
  }
  return deduped;
}

function getGrainRecordingId(recording) {
  return String(recording?.id || recording?.recording_id || recording?.recordingId || '').trim();
}

function getGrainRecordingTitle(recording) {
  return String(recording?.title || recording?.name || recording?.meeting_title || '').trim();
}

function getGrainRecordingStartMs(recording) {
  for (const key of ['start_time_ms', 'started_at_ms', 'scheduled_start_time_ms']) {
    if (Number.isFinite(recording?.[key])) return recording[key];
  }
  for (const key of ['start_time', 'started_at', 'start_datetime', 'recorded_at', 'created_at', 'date']) {
    const raw = recording?.[key];
    const parsed = raw ? new Date(raw).getTime() : 0;
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function getGrainRecordingUrl(recording) {
  const explicit = recording?.public_url || recording?.url || recording?.recording_url || recording?.share_url || recording?.app_url || recording?.meeting_url;
  if (explicit) return String(explicit);
  const id = getGrainRecordingId(recording);
  return id ? `https://grain.com/app/recordings/${id}` : '';
}

function getGrainParticipants(recording) {
  const participants = recording?.participants || recording?.attendees || recording?.people || [];
  return Array.isArray(participants) ? participants.filter(item => item && typeof item === 'object') : [];
}

function getGrainParticipantEmails(recording) {
  return getGrainParticipants(recording)
    .map(participant => normalizeDigestText(participant.email || participant.email_address))
    .filter(Boolean);
}

function isSalesOwnedGrainRecording(recording, config) {
  const ownerEmail = normalizeDigestText(recording?.owner?.email || recording?.creator?.email || recording?.user?.email);
  if (config.salesEmails.size > 0 && ownerEmail && config.salesEmails.has(ownerEmail)) return true;

  const ownerValues = Array.isArray(recording?.owners) ? recording.owners.map(normalizeDigestText) : [];
  if (config.salesEmails.size > 0 && ownerValues.some(owner => config.salesEmails.has(owner))) return true;

  const participantEmails = getGrainParticipantEmails(recording);
  if (config.salesEmails.size > 0 && participantEmails.some(email => config.salesEmails.has(email))) return true;

  const ownerId = normalizeDigestText(recording?.owner?.id || recording?.creator?.id || recording?.user?.id);
  if (config.salesOwnerIds.size > 0 && ownerId && config.salesOwnerIds.has(ownerId)) return true;

  if (config.salesEmails.size === 0 && config.salesOwnerIds.size === 0) return true;
  return false;
}

function isLikelyGrainDiscoveryRecording(recording, config) {
  if (!isSalesOwnedGrainRecording(recording, config)) return false;
  if (!hasExternalEmail(getGrainParticipantEmails(recording), config.internalDomains)) return false;

  const text = normalizeDigestText([
    getGrainRecordingTitle(recording),
    recording?.description,
    recording?.calendar_event?.title,
  ].filter(Boolean).join(' '));
  if (!text) return false;
  if (config.excludeTerms.some(term => term && text.includes(term))) return false;
  return config.includeTerms.some(term => term && text.includes(term));
}

function dedupeGrainRecordings(recordings) {
  const seen = new Set();
  const deduped = [];
  for (const recording of recordings || []) {
    const key = getGrainRecordingId(recording)
      || `${getGrainRecordingUrl(recording)}|${getGrainRecordingStartMs(recording)}|${getGrainRecordingTitle(recording)}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(recording);
  }
  return deduped;
}

function formatGrainTranscriptText(recording) {
  const transcript = recording?.transcript || recording?.transcript_text || recording?.text || '';
  if (typeof transcript === 'string') return transcript.trim();
  if (Array.isArray(transcript)) {
    return transcript.map(turn => {
      if (typeof turn === 'string') return turn;
      const speaker = turn?.speaker?.name || turn?.speaker_name || turn?.speaker || '?';
      const text = turn?.text || turn?.content || turn?.sentence || '';
      return text ? `${speaker}: ${text}` : '';
    }).filter(Boolean).join('\n');
  }
  if (transcript && Array.isArray(transcript.turns)) {
    return transcript.turns.map(turn => {
      const speaker = turn?.speaker?.name || turn?.speaker_name || turn?.speaker || '?';
      const text = turn?.text || turn?.content || '';
      return text ? `${speaker}: ${text}` : '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

function formatDigestContactLabel(contact) {
  if (!contact) return '';
  const name = `${contact.firstname || ''} ${contact.lastname || ''}`.trim();
  const company = String(contact.company || '').trim();
  const email = String(contact.email || '').trim();
  const label = [name, company ? `(${company})` : ''].filter(Boolean).join(' ');
  if (label && email) return `${label} <${email}>`;
  return label || email;
}

function formatNoShowMeetingLabel(meeting) {
  const contactLabel = formatDigestContactLabel(getPrimaryDigestContact(meeting));
  if (contactLabel) return contactLabel;
  return meeting?.properties?.hs_meeting_title || meeting?.title || 'Unknown';
}

function formatEmptyDiscoveryDigestMessage(dateLabel) {
  return `*Discovery Call Digest -- ${dateLabel}*\n\nNo discovery calls were scheduled for ${dateLabel}.`;
}

function getTokenOverlapScore(left, right) {
  const leftTokens = new Set(normalizeDigestText(left).split(/[^a-z0-9]+/).filter(token => token.length >= 3));
  const rightTokens = new Set(normalizeDigestText(right).split(/[^a-z0-9]+/).filter(token => token.length >= 3));
  let score = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) score += 1;
  }
  return score;
}

function findBestGrainRecordingForMeeting(meeting, recordings, config, usedRecordingIds = new Set()) {
  const hsStart = getDigestMeetingStartMs(meeting);
  if (!hsStart) return null;

  const meetingEmails = new Set(getContactEmails(meeting));
  const meetingTitle = meeting?.properties?.hs_meeting_title || '';
  const candidates = [];

  for (const recording of recordings || []) {
    const id = getGrainRecordingId(recording);
    if (id && usedRecordingIds.has(id)) continue;

    const startMs = getGrainRecordingStartMs(recording);
    if (!startMs) continue;
    const diff = Math.abs(startMs - hsStart);
    if (diff > config.matchWindowMs) continue;

    const grainEmails = getGrainParticipantEmails(recording);
    const emailOverlap = grainEmails.filter(email => meetingEmails.has(email)).length;
    const titleOverlap = getTokenOverlapScore(meetingTitle, getGrainRecordingTitle(recording));
    const score = (emailOverlap * 100) + (titleOverlap * 10) - (diff / 60000);
    candidates.push({ recording, score, diff });
  }

  candidates.sort((a, b) => b.score - a.score || a.diff - b.diff);
  return candidates[0]?.recording || null;
}

function parseListItems(payload) {
  if (Array.isArray(payload)) return { items: payload.filter(item => item && typeof item === 'object'), cursor: '', hasMore: false };
  if (!payload || typeof payload !== 'object') return { items: [], cursor: '', hasMore: false };
  const items = payload.recordings || payload.data || payload.results || payload.items || [];
  const cursor = payload.next_cursor || payload.cursor || payload.next || payload.next_page_token || '';
  const hasMore = Boolean(payload.has_more || cursor);
  return {
    items: Array.isArray(items) ? items.filter(item => item && typeof item === 'object') : [],
    cursor: String(cursor || ''),
    hasMore,
  };
}

module.exports = {
  buildDiscoveryDigestConfig,
  dedupeDigestMeetings,
  dedupeGrainRecordings,
  findBestGrainRecordingForMeeting,
  formatEmptyDiscoveryDigestMessage,
  formatGrainTranscriptText,
  formatNoShowMeetingLabel,
  getDigestMeetingStartMs,
  getGrainParticipantEmails,
  getGrainRecordingId,
  getGrainRecordingStartMs,
  getGrainRecordingTitle,
  getGrainRecordingUrl,
  isInternalEmail,
  isLikelyGrainDiscoveryRecording,
  isLikelyHubSpotDiscoveryMeeting,
  normalizeDigestText,
  parseListItems,
};
