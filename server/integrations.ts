import type { IntegrationBoundaries } from './types.ts';

export function getIntegrationBoundaries(): IntegrationBoundaries {
  const sarvamReady = Boolean(process.env.SARVAM_API_KEY?.trim());
  const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL?.trim();
  const n8nSecret = process.env.AUTOMATION_SHARED_SECRET?.trim();
  const n8nReady = Boolean(
    process.env.N8N_REMINDERS_VERIFIED === 'true' &&
      n8nWebhookUrl &&
      n8nSecret &&
      /^https?:\/\//i.test(n8nWebhookUrl)
  );

  return {
    sarvamVoice: {
      connected: sarvamReady,
      purpose: 'Tamil & mixed Tanglish speech-to-text and voice playback',
      note: sarvamReady
        ? 'Sarvam is enabled for server-side Tamil/English transcription and speech. Review the transcript before it is sent.'
        : 'Sarvam AI access is not configured; browser Web Speech API fallback and editable text input are active.',
    },
    n8nAutomation: {
      connected: n8nReady,
      requiresExplicitAuthorization: true,
      purpose: 'Authorized external reminders and compliance notifications',
      note: n8nReady
        ? 'n8n compliance reminder dispatcher is configured. Reminders only send when explicitly authorized by you.'
        : 'The n8n workflow is prepared. Add N8N_WEBHOOK_URL and AUTOMATION_SHARED_SECRET to enable explicit dispatch.',
    },
  };
}
