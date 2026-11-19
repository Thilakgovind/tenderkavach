import { createClient } from '@supabase/supabase-js';
import type { NextFunction, Request, Response } from 'express';
import { isValidSessionId } from './guardrails.ts';
import { lookupSession } from './sessionStore.ts';
import type { createSessionRepository } from './supabaseSessions.ts';
import type { SessionState } from './types.ts';

export function createSessionAuth(repository: ReturnType<typeof createSessionRepository>, liveOwners: Map<string, string>) {
  const projectUrl = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL)?.trim();
  const publishableKey = (
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY
  )?.trim();
  const auth = projectUrl && publishableKey
    ? createClient(projectUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;

  async function requireUser(req: Request, res: Response, next: NextFunction) {
    if (!auth) {
      if (!process.env.VERCEL) {
        res.locals.ownerId = 'local-dev';
        next();
        return;
      }
      res.status(401).json({ ok: false, error: 'Sign in to use live bid analysis.' });
      return;
    }
    const token = req.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) {
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

  function requireSessionOwner(req: Request<{ id: string }>, res: Response, next: NextFunction) {
    const id = req.params.id;
    if (req.method === 'POST' && (id === 'analyze' || id === 'sample')) return next();
    if (!isValidSessionId(id)) {
      res.status(400).json({ ok: false, error: 'Invalid session ID format.' });
      return;
    }
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
  }
  return { auth, requireUser, requireSessionOwner };
}

export function requestSession(req: Request, res: Response) {
  const session: SessionState | undefined = res.locals.savedSession;
  return session ? { status: 'found' as const, session } : lookupSession(req.params.id);
}
