import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGeminiStructuredProbe } from './server/geminiProbe.ts';
import { handleSessionChatTurn } from './server/chat.ts';
import { IngestionError, MAX_ZIP_BYTES } from './server/ingest.ts';
import { getActiveGeminiModel } from './server/llm.ts';
import {
  PipelineError,
  recheckCorrectedDocumentInSession,
  runLiveAnalysisPipeline,
} from './server/pipeline.ts';
import { renderHtmlReadinessReport } from './server/report.ts';
import {
  createSampleSession,
  getSampleCorrectedIsoPdfBuffer,
} from './server/sampleData.ts';
import {
  deleteSession,
  lookupSession,
  updateSession as updateMemorySession,
  type UpdateSessionResult,
} from './server/sessionStore.ts';
import { executeGroundedTool } from './server/tools.ts';
import { speak, transcribe, VoiceError } from './server/sarvam.ts';
import { createSessionRepository } from './server/supabaseSessions.ts';
import type { SessionState } from './server/types.ts';
import type { ChatLanguage, IntegrationBoundaries } from './server/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_ZIP_BYTES,
    files: 4,
  },
});

function getIntegrationBoundaries(): IntegrationBoundaries {
  const sarvamReady = Boolean(process.env.SARVAM_API_KEY?.trim());
  return {
  sarvamVoice: {
    connected: sarvamReady,
    purpose: 'Tamil & mixed Tanglish speech-to-text transcription',
    note: sarvamReady
      ? 'Sarvam is enabled for server-side Tamil/English transcription. Review the transcript before it is sent.'
      : 'Sarvam AI access is not configured; browser Web Speech API fallback and editable text input are active.',
  },
  n8nAutomation: {
    connected: Boolean(process.env.AUTOMATION_SHARED_SECRET?.trim()),
    requiresExplicitAuthorization: true,
    purpose: 'Authorized external reminders and compliance notifications',
    note: process.env.AUTOMATION_SHARED_SECRET?.trim()
      ? 'Authorized n8n dispatch is enabled server-side.'
      : 'Configure AUTOMATION_SHARED_SECRET to enable authorized n8n dispatch.',
  },
  };
}

export function createApiRouter() {
  const router = express.Router();
  const repository = createSessionRepository();
  const liveOwners = new Map<string, string>();
  const projectUrl = process.env.VITE_SUPABASE_URL;
  const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const auth = projectUrl && publishableKey
    ? createClient(projectUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;

  async function requireUser(req: Request, res: Response, next: NextFunction) {
    const token = req.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1];
    if (!auth || !token) {
      res.status(401).json({ ok: false, error: 'Sign in to use live bid analysis.' });
      return;
    }
    try {
      const { data, error } = await auth.auth.getUser(token);
      if (error || !data.user || data.user.is_anonymous) {
        res.status(401).json({ ok: false, error: 'Sign in again to continue.' });
        return;
      }
      res.locals.ownerId = data.user.id;
      next();
    } catch {
      res.status(503).json({ ok: false, error: 'Sign-in verification is temporarily unavailable.' });
    }
  }

  router.use('/sessions/:id', (req, res, next) => {
    const id = req.params.id;
    if (req.method === 'POST' && (id === 'analyze' || id === 'sample')) return next();
    const found = lookupSession(id);
    if (repository && !(found.status === 'found' && found.session.mode === 'SAMPLE')) {
      void requireUser(req, res, () => {
        void repository.get(res.locals.ownerId, id).then((session) => {
          if (!session) {
            res.status(404).json({ ok: false, code: 'missing', error: 'Session not found.' });
            return;
          }
          res.locals.savedSession = session;
          next();
        }).catch(next);
      });
      return;
    }
    if (found.status !== 'found' || found.session.mode === 'SAMPLE') {
      if (found.status === 'expired') liveOwners.delete(id);
      next();
      return;
    }
    void requireUser(req, res, () => {
      if (liveOwners.get(id) !== res.locals.ownerId) {
        res.status(404).json({ ok: false, error: 'Session not found.' });
        return;
      }
      next();
    });
  });

  function requestSession(req: Request, res: Response) {
    const session: SessionState | undefined = res.locals.savedSession;
    return session ? { status: 'found' as const, session } : lookupSession(req.params.id);
  }

  async function updateSession(
    res: Response,
    id: string,
    expectedRevision: number | undefined,
    mutate: (draft: SessionState) => void | Promise<void>,
  ): Promise<UpdateSessionResult> {
    const state: SessionState | undefined = res.locals.savedSession;
    if (!repository || !state) return updateMemorySession(id, expectedRevision, mutate);
    const conflict = { ok: false as const, code: 'conflict' as const, message: 'Session changed. Reload before retrying.' };
    if (expectedRevision !== undefined && state.revision !== expectedRevision) return conflict;
    const draft = structuredClone(state);
    await mutate(draft);
    draft.revision++;
    draft.updatedAt = new Date().toISOString();
    return await repository.update(res.locals.ownerId, draft, state.revision)
      ? { ok: true, session: draft }
      : conflict;
  }

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'namma-tender-api',
      provider: process.env.LLM_PROVIDER || 'gemini',
      model: getActiveGeminiModel(),
      keyConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()),
      integrations: getIntegrationBoundaries(),
    });
  });

  router.get('/integrations/status', (_req, res) => {
    res.json(getIntegrationBoundaries());
  });

  router.post('/automation/jobs/execute', (req, res) => {
    const expectedSecret = process.env.AUTOMATION_SHARED_SECRET?.trim();
    const suppliedSecret = req.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1];
    if (!expectedSecret) {
      res.status(503).json({ ok: false, error: 'Automation is not configured.' });
      return;
    }
    if (!suppliedSecret || suppliedSecret !== expectedSecret) {
      res.status(401).json({ ok: false, error: 'Unauthorized automation request.' });
      return;
    }
    const { job_id: jobId, action, expected_revision: expectedRevision } = req.body || {};
    if (typeof jobId !== 'string' || !jobId.trim() || typeof action !== 'string' || !action.trim()) {
      res.status(400).json({ ok: false, error: 'job_id and action are required.' });
      return;
    }
    res.status(202).json({
      ok: true,
      status: 'accepted',
      job_id: jobId,
      action,
      expected_revision: typeof expectedRevision === 'number' ? expectedRevision : null,
      message: 'Authorized automation job accepted for processing.',
    });
  });

  router.post('/voice/transcribe', upload.single('audio'), async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ ok: false, error: 'Audio file is required.' });
        return;
      }
      const result = await transcribe(req.file.buffer, req.file.mimetype || 'audio/webm');
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof VoiceError) {
        res.status(err.status).json({ ok: false, error: err.message });
        return;
      }
      next(err);
    }
  });

  router.post('/voice/speak', async (req, res, next) => {
    try {
      const text = typeof req.body?.text === 'string' ? req.body.text : '';
      const language = req.body?.language === 'en-IN' ? 'en-IN' : 'ta-IN';
      const result = await speak(text, language);
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof VoiceError) {
        res.status(err.status).json({ ok: false, error: err.message });
        return;
      }
      next(err);
    }
  });

  router.post('/gemini/probe', async (req, res) => {
    const requestedModel =
      typeof req.body?.model === 'string' && req.body.model.trim()
        ? req.body.model.trim()
        : getActiveGeminiModel();
    const result = await runGeminiStructuredProbe(requestedModel);
    if (!result.ok) {
      res.status(result.httpStatus).json(result);
      return;
    }
    res.json(result);
  });

  // Sample Mode endpoints
  router.post('/sessions/sample', (_req, res) => {
    const session = createSampleSession();
    res.status(201).json({
      ok: true,
      session,
      progressSteps: session.chatHistory[0]?.progressSteps || [],
    });
  });

  router.get('/sample/corrected-iso.pdf', (_req, res) => {
    const pdfBuf = getSampleCorrectedIsoPdfBuffer();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="Sample_Renewed_ISO_9001.pdf"');
    res.send(pdfBuf);
  });

  // Live Mode document intake + analysis
  router.post(
    '/sessions/analyze',
    requireUser,
    upload.fields([
      { name: 'tenderPdf', maxCount: 1 },
      { name: 'supplierZip', maxCount: 1 },
      { name: 'corrigendumPdf', maxCount: 1 },
    ]),
    async (req, res, next) => {
      try {
        const files = (req.files || {}) as Record<string, Express.Multer.File[]>;
        const tenderFile = files.tenderPdf?.[0];
        const supplierZipFile = files.supplierZip?.[0];
        const corrigendumFile = files.corrigendumPdf?.[0];

        const companyName = String(req.body?.companyName || '').trim();
        const district = String(req.body?.district || '').trim();
        const sector = String(req.body?.sector || '').trim();
        const deadline = String(req.body?.deadline || '').trim();
        const tenderReference = String(req.body?.tenderReference || '').trim() || undefined;
        const email = String(req.body?.email || '').trim() || undefined;
        const idempotencyKey =
          typeof req.headers['x-idempotency-key'] === 'string'
            ? req.headers['x-idempotency-key']
            : undefined;

        if (!companyName || !district || !sector || !deadline) {
          res.status(400).json({
            ok: false,
            error: 'Company name, Tamil Nadu district, sector, and confirmed bid deadline are required.',
          });
          return;
        }
        if (!tenderFile) {
          res.status(400).json({ ok: false, error: 'Tender PDF upload is required.' });
          return;
        }
        if (!supplierZipFile) {
          res.status(400).json({ ok: false, error: 'Supplier documents ZIP upload is required.' });
          return;
        }

        const result = await runLiveAnalysisPipeline({
          profile: {
            companyName,
            district,
            sector,
            tenderReference,
            email,
          },
          confirmedDeadline: deadline,
          tenderFile: { buffer: tenderFile.buffer, originalname: tenderFile.originalname },
          supplierZipFile: {
            buffer: supplierZipFile.buffer,
            originalname: supplierZipFile.originalname,
          },
          corrigendumFile: corrigendumFile
            ? {
                buffer: corrigendumFile.buffer,
                originalname: corrigendumFile.originalname,
              }
            : undefined,
          idempotencyKey: idempotencyKey ? `${res.locals.ownerId}:${idempotencyKey}` : undefined,
        });
        liveOwners.set(result.session.sessionId, res.locals.ownerId);
        if (repository) await repository.create(res.locals.ownerId, result.session);

        res.status(201).json({
          ok: true,
          session: result.session,
          progressSteps: result.progressSteps,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // Retrieve authoritative session state
  router.get('/sessions/:id', (req, res) => {
    const found = requestSession(req, res);
    if (found.status === 'missing') {
      res.status(404).json({
        ok: false,
        code: 'missing',
        error: 'Session not found. It may have been cleared on server restart.',
      });
      return;
    }
    if (found.status === 'expired') {
      res.status(410).json({
        ok: false,
        code: 'expired',
        error: 'Session has expired. Please re-upload documents or open Sample Mode.',
      });
      return;
    }
    res.json({ ok: true, session: found.session });
  });

  // Delete session
  router.delete('/sessions/:id', async (req, res, next) => {
    if (repository && res.locals.savedSession) {
      try {
        await repository.remove(res.locals.ownerId, req.params.id);
      } catch (error) {
        next(error);
        return;
      }
      deleteSession(req.params.id);
      liveOwners.delete(req.params.id);
      res.json({ ok: true });
      return;
    }
    const deleted = deleteSession(req.params.id);
    if (!deleted) {
      res.status(404).json({ ok: false, error: 'Session not found.' });
      return;
    }
    liveOwners.delete(req.params.id);
    res.json({ ok: true });
  });

  // Grounded chat endpoint
  router.post('/sessions/:id/chat', async (req, res, next) => {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    const languageRaw = req.body?.language;
    const language: ChatLanguage =
      languageRaw === 'Tam' || languageRaw === 'Hin' ? languageRaw : 'Eng';
    const expectedRevision =
      typeof req.body?.revision === 'number' ? req.body.revision : undefined;

    if (!message) {
      res.status(400).json({ ok: false, error: 'Message text is required.' });
      return;
    }

    let chatOutput: Awaited<ReturnType<typeof handleSessionChatTurn>> | undefined;
    const updated = await updateSession(res, req.params.id, expectedRevision, async (draft) => {
      chatOutput = await handleSessionChatTurn({
        session: draft,
        message,
        language,
      });
    }).catch((error: unknown) => { next(error); return null; });
    if (!updated) return;

    if (!updated.ok) {
      const status =
        updated.code === 'missing'
          ? 404
          : updated.code === 'expired'
            ? 410
            : updated.code === 'conflict'
              ? 409
              : 423;
      res.status(status).json({
        ok: false,
        code: updated.code,
        error: updated.message,
        currentRevision: updated.currentRevision,
      });
      return;
    }

    res.json({
      ok: true,
      session: updated.session,
      reply: chatOutput?.reply,
      toolUsed: chatOutput?.toolUsed,
      progressSteps: chatOutput?.progressSteps || [],
      citedRequirements: chatOutput?.citedRequirements || [],
      exportReady: Boolean(chatOutput?.exportReady),
    });
  });

  // Explicit human decision / feedback endpoint
  router.post('/sessions/:id/decision', async (req, res, next) => {
    const requirementId =
      typeof req.body?.requirementId === 'string' ? req.body.requirementId.trim() : undefined;
    const action = typeof req.body?.action === 'string' ? req.body.action : 'agree';
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    const languageRaw = req.body?.language;
    const language: ChatLanguage =
      languageRaw === 'Tam' || languageRaw === 'Hin' ? languageRaw : 'Eng';
    const expectedRevision =
      typeof req.body?.revision === 'number' ? req.body.revision : undefined;

    let toolResult: ReturnType<typeof executeGroundedTool> | undefined;
    const updated = await updateSession(res, req.params.id, expectedRevision, (draft) => {
      if (action === 'approve') {
        toolResult = executeGroundedTool({
          session: draft,
          tool: 'record_decision',
          userMessage: note || `Approve ${requirementId || ''}`,
          language,
          requirementId,
          decision: 'approved_after_review',
          note,
        });
      } else if (action === 'dispute') {
        toolResult = executeGroundedTool({
          session: draft,
          tool: 'record_feedback',
          userMessage: note || `I disagree with finding for ${requirementId || ''}`,
          language,
          requirementId,
          decision: 'disputed',
          note,
        });
      } else {
        toolResult = executeGroundedTool({
          session: draft,
          tool: 'record_feedback',
          userMessage: note || `Agreed with finding for ${requirementId || ''}`,
          language,
          requirementId,
          note,
        });
      }
    }).catch((error: unknown) => { next(error); return null; });
    if (!updated) return;

    if (!updated.ok) {
      const status =
        updated.code === 'missing' ? 404 : updated.code === 'expired' ? 410 : 409;
      res.status(status).json({ ok: false, code: updated.code, error: updated.message });
      return;
    }

    res.status(toolResult?.ok === false ? 422 : 200).json({
      ok: toolResult?.ok ?? true,
      session: updated.session,
      message: toolResult?.reply,
    });
  });

  // Upload corrected PDF & rerun affected checks
  router.post(
    '/sessions/:id/correct',
    upload.single('correctedPdf'),
    async (req, res, next) => {
      try {
        const file = req.file;
        if (!file) {
          res.status(400).json({ ok: false, error: 'Please attach a corrected PDF file.' });
          return;
        }
        const targetRequirementId =
          typeof req.body?.targetRequirementId === 'string' && req.body.targetRequirementId.trim()
            ? req.body.targetRequirementId.trim()
            : undefined;
        const expectedRevision = req.body?.revision ? Number(req.body.revision) : undefined;

        let recheckInfo:
          | { affectedRequirements: string[]; progressSteps: string[] }
          | undefined;

        const updated = await updateSession(
          res,
          req.params.id,
          Number.isFinite(expectedRevision) ? expectedRevision : undefined,
          async (draft) => {
            const out = await recheckCorrectedDocumentInSession({
              session: draft,
              correctedFile: { buffer: file.buffer, originalname: file.originalname },
              targetRequirementId,
            });
            recheckInfo = {
              affectedRequirements: out.affectedRequirements,
              progressSteps: out.progressSteps,
            };
          }
        );

        if (!updated.ok) {
          const status =
            updated.code === 'missing' ? 404 : updated.code === 'expired' ? 410 : 409;
          res.status(status).json({ ok: false, code: updated.code, error: updated.message });
          return;
        }

        res.json({
          ok: true,
          session: updated.session,
          affectedRequirements: recheckInfo?.affectedRequirements || [],
          progressSteps: recheckInfo?.progressSteps || [],
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // Download or preview escaped HTML Bid Readiness Report
  router.get('/sessions/:id/report', (req, res) => {
    const found = requestSession(req, res);
    if (found.status === 'missing') {
      res.status(404).json({ ok: false, error: 'Session not found.' });
      return;
    }
    if (found.status === 'expired') {
      res.status(410).json({ ok: false, error: 'Session expired.' });
      return;
    }

    const html = renderHtmlReadinessReport(found.session);
    if (req.query.format === 'json') {
      res.json({
        ok: true,
        html,
        revision: found.session.revision,
      });
      return;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="NammaTender_Report_${found.session.sessionId}.html"`
    );
    res.send(html);
  });

  // Error handler for upload, ingestion, and pipeline failures
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      res.status(400).json({
        ok: false,
        category: 'upload_limit',
        error: `Upload error: ${err.message}`,
      });
      return;
    }
    if (err instanceof IngestionError || err instanceof PipelineError) {
      res.status(err.statusCode).json({
        ok: false,
        category: err instanceof PipelineError ? err.category : 'ingestion_error',
        error: err.message,
      });
      return;
    }
    const clean =
      err instanceof Error ? err.message.replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[REDACTED]') : 'Server error';
    res.status(500).json({ ok: false, error: clean });
  });

  return router;
}

export async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', createApiRouter());

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  return app.listen(PORT, '0.0.0.0', () => {
    console.log(`Namma Tender server listening on http://0.0.0.0:${PORT}`);
  });
}

// Start only when this module is the entrypoint. Tests import createApiRouter()
// and must never open a second Vite/WebSocket server as an import side effect.
const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isEntrypoint) {
  startServer().catch((err) => {
    console.error('Failed to start Namma Tender server:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
