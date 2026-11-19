import type { IntegrationBoundaries, SessionState } from '../../server/types';

export type HealthResponse = {
  ok: boolean;
  provider: string;
  model: string;
  keyConfigured: boolean;
  integrations: IntegrationBoundaries;
};

type ApiEnvelope = { ok: boolean; error?: string; code?: string; category?: string };
type SessionResponse = ApiEnvelope & { session?: SessionState };
type ChatResponse = SessionResponse & {
  reply?: string; toolUsed?: string; progressSteps?: string[];
  citedRequirements?: string[]; exportReady?: boolean;
};
type DecisionResponse = SessionResponse & { message?: string };
type CorrectResponse = SessionResponse & { affectedRequirements?: string[]; progressSteps?: string[] };
type ReportResponse = ApiEnvelope & { html?: string; revision?: number };
type VoiceTranscriptResponse = ApiEnvelope & { transcript?: string };
type VoiceSpeechResponse = ApiEnvelope & { audio_base64?: string; mime_type?: string };
type AutomateResponse = SessionResponse & { message?: string };

function invalid(route: string): never {
  throw new Error(`INVALID_API_RESPONSE: ${route}`);
}

function object(value: unknown, route: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(route);
  return value as Record<string, unknown>;
}

function requiredBoolean(value: unknown, route: string): boolean {
  if (typeof value !== 'boolean') invalid(route);
  return value;
}

function optionalString(value: unknown, route: string): string | undefined {
  if (value !== undefined && typeof value !== 'string') invalid(route);
  return value as string | undefined;
}

function stringArray(value: unknown, route: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) invalid(route);
  return value;
}

function isSessionState(value: unknown): value is SessionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  return typeof s.sessionId === 'string' &&
    (s.mode === 'LIVE' || s.mode === 'SAMPLE') &&
    typeof s.createdAt === 'string' && typeof s.updatedAt === 'string' &&
    typeof s.expiresAt === 'string' && typeof s.profile === 'object' &&
    typeof s.deadline === 'object' && Array.isArray(s.requirements) &&
    Array.isArray(s.evidence) && Array.isArray(s.matches) &&
    Array.isArray(s.validation) && Array.isArray(s.plan) &&
    Array.isArray(s.decisions) && Array.isArray(s.feedback) &&
    Array.isArray(s.audit_events) && Array.isArray(s.warnings) &&
    typeof s.provider === 'object' && s.provider !== null &&
    (s.provider as Record<string, unknown>).provider === 'gemini' &&
    ['live', 'sample', 'degraded'].includes((s.provider as Record<string, unknown>).extractionMode as string) &&
    typeof s.revision === 'number' &&
    Array.isArray(s.chatHistory);
}

function envelope(value: unknown, route: string): Record<string, unknown> {
  const data = object(value, route);
  requiredBoolean(data.ok, route);
  optionalString(data.error, route);
  optionalString(data.code, route);
  optionalString(data.category, route);
  return data;
}

function sessionResponse<T extends SessionResponse>(value: unknown, route: string): T {
  const data = envelope(value, route);
  if (data.ok && !isSessionState(data.session)) invalid(route);
  if (data.session !== undefined && !isSessionState(data.session)) invalid(route);
  return data as T;
}

export function validateHealth(value: unknown): HealthResponse {
  const data = envelope(value, 'health');
  if (typeof data.provider !== 'string' || typeof data.model !== 'string' ||
      typeof data.keyConfigured !== 'boolean') invalid('health');
  const integrations = object(data.integrations, 'health');
  if (!integrations.sarvamVoice || !integrations.n8nAutomation) invalid('health');
  return data as unknown as HealthResponse;
}

export function validateSessionState(value: unknown): SessionState {
  if (!isSessionState(value)) invalid('session');
  return value;
}

export function validateSessionResponse(value: unknown): SessionResponse {
  return sessionResponse<SessionResponse>(value, 'session');
}

export function validateChatResponse(value: unknown): ChatResponse {
  const data = sessionResponse<ChatResponse>(value, 'chat');
  optionalString(data.reply, 'chat'); optionalString(data.toolUsed, 'chat');
  if (data.progressSteps !== undefined) stringArray(data.progressSteps, 'chat');
  if (data.citedRequirements !== undefined) stringArray(data.citedRequirements, 'chat');
  if (data.exportReady !== undefined) requiredBoolean(data.exportReady, 'chat');
  return data;
}

export function validateDecisionResponse(value: unknown): DecisionResponse {
  const data = sessionResponse<DecisionResponse>(value, 'decision');
  optionalString(data.message, 'decision');
  return data;
}

export function validateCorrectResponse(value: unknown): CorrectResponse {
  const data = sessionResponse<CorrectResponse>(value, 'correct');
  if (data.affectedRequirements !== undefined) stringArray(data.affectedRequirements, 'correct');
  if (data.progressSteps !== undefined) stringArray(data.progressSteps, 'correct');
  return data;
}

export function validateReportResponse(value: unknown): ReportResponse {
  const data = envelope(value, 'report');
  if (data.ok && typeof data.html !== 'string') invalid('report');
  if (data.html !== undefined && typeof data.html !== 'string') invalid('report');
  if (data.revision !== undefined && (typeof data.revision !== 'number' || !Number.isFinite(data.revision))) invalid('report');
  return data as ReportResponse;
}

export function validateVoiceTranscript(value: unknown): VoiceTranscriptResponse {
  const data = envelope(value, 'voice-transcribe');
  if (data.ok && typeof data.transcript !== 'string') invalid('voice-transcribe');
  optionalString(data.transcript, 'voice-transcribe');
  return data as VoiceTranscriptResponse;
}

export function validateVoiceSpeech(value: unknown): VoiceSpeechResponse {
  const data = envelope(value, 'voice-speak');
  if (data.ok && (typeof data.audio_base64 !== 'string' || typeof data.mime_type !== 'string')) invalid('voice-speak');
  optionalString(data.audio_base64, 'voice-speak'); optionalString(data.mime_type, 'voice-speak');
  return data as VoiceSpeechResponse;
}

export function validateAutomateResponse(value: unknown): AutomateResponse {
  const data = sessionResponse<AutomateResponse>(value, 'automate');
  optionalString(data.message, 'automate');
  return data;
}
