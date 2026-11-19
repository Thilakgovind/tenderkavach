import type { SessionState } from './types.ts';

export function validateSessionState(value: unknown): SessionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_API_RESPONSE: session');
  }
  const state = value as Record<string, unknown>;
  const provider = state.provider as Record<string, unknown> | null;
  if (typeof state.sessionId !== 'string' ||
      (state.mode !== 'LIVE' && state.mode !== 'SAMPLE') ||
      typeof state.createdAt !== 'string' || typeof state.updatedAt !== 'string' ||
      typeof state.expiresAt !== 'string' || typeof state.profile !== 'object' ||
      typeof state.deadline !== 'object' || !Array.isArray(state.requirements) ||
      !Array.isArray(state.evidence) || !Array.isArray(state.matches) ||
      !Array.isArray(state.validation) || !Array.isArray(state.plan) ||
      !Array.isArray(state.decisions) || !Array.isArray(state.feedback) ||
      !Array.isArray(state.audit_events) || !Array.isArray(state.warnings) ||
      !provider || provider.provider !== 'gemini' ||
      !['live', 'sample', 'degraded'].includes(String(provider.extractionMode)) ||
      typeof state.revision !== 'number' || !Array.isArray(state.chatHistory)) {
    throw new Error('INVALID_API_RESPONSE: session');
  }
  return value as SessionState;
}
