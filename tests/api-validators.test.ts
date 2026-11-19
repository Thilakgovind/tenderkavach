import assert from 'node:assert/strict';
import test from 'node:test';
import { createSampleSession } from '../server/sampleData.ts';
import {
  validateAutomateResponse,
  validateChatResponse,
  validateCorrectResponse,
  validateDecisionResponse,
  validateHealth,
  validateReportResponse,
  validateSessionResponse,
  validateVoiceSpeech,
  validateVoiceTranscript,
} from '../src/api/validators.ts';

const session = createSampleSession();
const health = {
  ok: true,
  provider: 'gemini',
  model: 'gemini-3.1-flash-lite',
  keyConfigured: false,
  integrations: {
    sarvamVoice: { connected: false, purpose: 'voice', note: 'not configured' },
    n8nAutomation: { connected: false, requiresExplicitAuthorization: true, purpose: 'reminders', note: 'not configured' },
  },
};

function assertInvalid(fn: () => unknown, route: string) {
  assert.throws(fn, new RegExp(`INVALID_API_RESPONSE: ${route}`));
}

test('validateHealth accepts a valid health response and rejects malformed input', () => {
  assert.equal(validateHealth(health).model, health.model);
  assertInvalid(() => validateHealth({ ok: true }), 'health');
  assertInvalid(() => validateHealth({ ...health, ok: 'yes' }), 'health');
});

test('validateSessionResponse accepts a session and rejects missing or malformed sessions', () => {
  assert.equal(validateSessionResponse({ ok: true, session }).session?.sessionId, session.sessionId);
  assertInvalid(() => validateSessionResponse({ ok: true }), 'session');
  assertInvalid(() => validateSessionResponse({ ok: true, session: { sessionId: 7 } }), 'session');
});

test('validateChatResponse validates session, arrays and optional fields', () => {
  assert.equal(validateChatResponse({ ok: true, session, reply: 'Ready', progressSteps: [], citedRequirements: [] }).reply, 'Ready');
  assertInvalid(() => validateChatResponse({ ok: true, session, progressSteps: 'step' }), 'chat');
  assertInvalid(() => validateChatResponse({ ok: true, session, citedRequirements: [2] }), 'chat');
});

test('validateDecisionResponse accepts a decision response and rejects a wrong message type', () => {
  assert.equal(validateDecisionResponse({ ok: true, session, message: 'Recorded' }).message, 'Recorded');
  assertInvalid(() => validateDecisionResponse({ ok: true, session, message: 4 }), 'decision');
});

test('validateCorrectResponse validates affected requirement arrays', () => {
  assert.deepEqual(validateCorrectResponse({ ok: true, session, affectedRequirements: ['R2'], progressSteps: [] }).affectedRequirements, ['R2']);
  assertInvalid(() => validateCorrectResponse({ ok: true, session, affectedRequirements: 'R2' }), 'correct');
});

test('validateReportResponse validates HTML and revision', () => {
  assert.equal(validateReportResponse({ ok: true, html: '<html/>', revision: 2 }).revision, 2);
  assertInvalid(() => validateReportResponse({ ok: true, html: 42 }), 'report');
});

test('validateVoiceTranscript validates transcript responses', () => {
  assert.equal(validateVoiceTranscript({ ok: true, transcript: 'வணக்கம்' }).transcript, 'வணக்கம்');
  assertInvalid(() => validateVoiceTranscript({ ok: true, transcript: ['wrong'] }), 'voice-transcribe');
});

test('validateVoiceSpeech validates audio responses', () => {
  assert.equal(validateVoiceSpeech({ ok: true, audio_base64: 'AA==', mime_type: 'audio/wav' }).mime_type, 'audio/wav');
  assertInvalid(() => validateVoiceSpeech({ ok: true, audio_base64: 'AA==' }), 'voice-speak');
});

test('validateAutomateResponse validates automation responses', () => {
  assert.equal(validateAutomateResponse({ ok: true, session, message: 'Sent' }).message, 'Sent');
  assertInvalid(() => validateAutomateResponse({ ok: true, session, message: 9 }), 'automate');
});

test('validators preserve safe failure envelopes without reading response bodies', () => {
  const failure = validateSessionResponse({ ok: false, error: 'Sign in to continue.', code: 'AUTH_REQUIRED' });
  assert.equal(failure.ok, false);
  assert.equal(failure.error, 'Sign in to continue.');
  assert.equal(failure.code, 'AUTH_REQUIRED');
});
