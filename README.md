<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Namma Tender — TenderKavach

Tamil Nadu MSME bid-readiness assistant. It extracts tender requirements from the uploaded tender PDF, cross-checks supplier evidence, refuses unsupported compliance overrides, creates a correction-first rescue plan, and exports a cited readiness report.

## What is live in this repository

- Animated Namma Tender frontend and bilingual Tamil/English workflow.
- Express/TypeScript tender PDF + supplier ZIP intake.
- Gemini structured extraction, evidence matching, deterministic validation and Sentinel checks.
- Grounded chat, correction/recheck, feedback, and report export.
- Optional Supabase passwordless email sign-in (browser-safe environment variables only).
- Optional Sarvam Tamil/English voice transcription; every transcript remains editable before it is sent.
- n8n integration boundary is deliberately inactive until a deployed backend URL and separate server-to-server credential are configured. It never submits a bid or sends external messages automatically.

## Security boundaries

- Do not commit `.env`, `GEMINI_API_KEY`, `SARVAM_API_KEY`, service-role keys, or n8n credentials.
- Tender documents must use the private `tender-documents/<auth-user-id>/...` bucket and user-owned RLS policies in Supabase.
- A chat message, human decision, or n8n workflow may not mark a failed finding as PASS without new validated evidence.
- Use a dedicated `AUTOMATION_SHARED_SECRET` only between the deployed backend and n8n, never in a browser.

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/9b0375b4-5ade-4afb-a4d0-e190dd8910a3

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

4. Run verification:
   `npm run lint`
   `npm test`
   `npm run build`

## Environment

Copy `.env.example` to `.env.local`. For Supabase add the project URL and **publishable** key as `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Add server-only `SARVAM_API_KEY` only if Tamil voice is enabled. The n8n dispatcher stays disabled until the deployment URL and a separate `AUTOMATION_SHARED_SECRET` are configured.
