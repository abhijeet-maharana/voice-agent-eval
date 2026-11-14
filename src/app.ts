import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type RequestHandler, type Response } from 'express';
import { gradeSession, gradingConfigured, reviewPrompt, writeNotes } from './review';
import { appendLog, cleanupSessions, deleteSession, endSession, loadSession, pageOptions, runTool, saveDebrief, saveReview, startDebrief, startSession } from './sessions';
import { HttpError, loadConfig } from './workspace';

/**
 * The whole app as one Express router: the session API under `api/` and the built page (web/dist) at the
 * root. `src/server.ts` mounts it at `/` for the standalone app; another Express app can mount it at any
 * path, e.g. `app.use('/interview', createInterviewApp({ workspace, guard, onReview }))`. The page uses
 * relative URLs, so it works under any prefix, including behind a reverse proxy.
 */

export type ReviewEvent =
  | {
      type: 'reviewed';
      sessionId: string;
      round: string;
      overall: number;
      summary: string;
      weakest: { question: string; score: number; fix: string } | null;
      nextFocus: string[];
      report: string;
      interviewerBugs: string[];
    }
  | { type: 'failed'; sessionId: string; round: string; error: string };

export interface InterviewAppOptions {
  /** The workspace folder (sets WORKSPACE for this process). */
  workspace?: string;
  /** Runs before the routes that spend money: starting a call, grading, a spoken debrief. E.g. a login check. */
  guard?: RequestHandler;
  /** Runs before the page itself is served. */
  pageGuard?: RequestHandler;
  /** Called after Claude grades a call, or when grading fails. Errors it throws are logged, never raised. */
  onReview?: (event: ReviewEvent) => unknown;
  /** Deletes unanswered sessions and compacts old ones every 6 hours (default true). */
  cleanup?: boolean;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.join(here, '..', 'web', 'dist');
const pass: RequestHandler = (_req, _res, next) => next();

export function createInterviewApp(opts: InterviewAppOptions = {}): express.Router {
  if (opts.workspace) process.env.WORKSPACE = opts.workspace;
  const guard = opts.guard ?? pass;
  const router = express.Router();
  router.use(express.json({ limit: '4mb' }));

  const handle = (fn: (req: Request) => unknown) => async (req: Request, res: Response) => {
    try {
      res.json({ result: await fn(req) });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error(`[voice-interviewer] ${req.method} ${req.path}:`, (err as Error).message);
      res.status(status).json({ error: (err as Error).message });
    }
  };
  const id = (req: Request) => String(req.params.id);

  const notify = async (event: ReviewEvent) => {
    const hooks: Promise<unknown>[] = [];
    if (opts.onReview) hooks.push(Promise.resolve().then(() => opts.onReview!(event)));
    if (process.env.REVIEW_WEBHOOK_URL)
      hooks.push(fetch(process.env.REVIEW_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event), signal: AbortSignal.timeout(10_000) }));
    for (const r of await Promise.allSettled(hooks)) if (r.status === 'rejected') console.error('[voice-interviewer] review hook failed:', (r.reason as Error)?.message ?? r.reason);
  };

  /** Starts grading in the background; the page polls the session until the review lands. */
  const gradeLater = (sessionId: string) => {
    if (!gradingConfigured()) return 'not configured: set ANTHROPIC_API_KEY, or grade by hand with the review prompt';
    const round = (() => {
      const s = loadSession(sessionId);
      return loadConfig().rounds.find((r) => r.id === s.round)?.label ?? s.round;
    })();
    gradeSession(sessionId).then(
      (r) => {
        const review = loadSession(sessionId).review!;
        const weakest = [...review.answers].sort((a, b) => a.score - b.score)[0];
        console.log(`[voice-interviewer] reviewed ${sessionId}: ${r.overall}/10`);
        void notify({
          type: 'reviewed',
          sessionId,
          round,
          overall: review.overall,
          summary: review.summary,
          weakest: weakest ? { question: weakest.question, score: weakest.score, fix: weakest.fix } : null,
          nextFocus: review.next_focus,
          report: r.report,
          interviewerBugs: r.bugs,
        });
      },
      (err) => {
        console.error(`[voice-interviewer] grading ${sessionId} failed: ${(err as Error).message}`);
        void notify({ type: 'failed', sessionId, round, error: (err as Error).message });
      },
    );
    return 'grading';
  };

  router.get('/api/options', handle(() => pageOptions(new Date(), gradingConfigured())));
  router.post('/api/sessions', guard, handle((req) => startSession(req.body || {})));
  router.get('/api/sessions/:id', handle((req) => loadSession(id(req))));
  // Deleting forgets the session: its file, its report, and its effect on spaced repetition.
  router.delete('/api/sessions/:id', guard, handle((req) => deleteSession(id(req))));
  router.post(
    '/api/sessions/:id/tool',
    handle((req) => runTool(id(req), String(req.body?.name ?? '').slice(0, 60), req.body?.args && typeof req.body.args === 'object' ? req.body.args : {}, new Date(), Number(req.body?.t))),
  );
  router.post('/api/sessions/:id/log', handle((req) => appendLog(id(req), req.body?.entries)));
  router.post(
    '/api/sessions/:id/end',
    handle((req) => {
      const r = endSession(id(req), req.body || {});
      return { session: r.session, review: r.gradable ? gradeLater(r.session.id) : r.note };
    }),
  );
  router.post(
    '/api/sessions/:id/grade',
    guard,
    handle((req) => {
      const s = loadSession(id(req));
      if (s.review) throw new HttpError(409, 'Already reviewed');
      if (s.grading && Date.now() - Date.parse(s.grading.startedAt) < 10 * 60_000) throw new HttpError(409, 'Already grading');
      return { review: gradeLater(s.id) };
    }),
  );
  router.get('/api/sessions/:id/review-prompt', (req, res) => {
    try {
      res.type('text/plain').send(reviewPrompt(id(req)));
    } catch (err) {
      res.status(err instanceof HttpError ? err.status : 500).type('text/plain').send((err as Error).message);
    }
  });
  // A review graded elsewhere (the JSON a Claude chat returned for the review prompt).
  router.post(
    '/api/sessions/:id/review',
    handle((req) => {
      const body = req.body || {};
      const r = saveReview(id(req), body);
      const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
      if (body.coach_notes && Array.isArray(body.interviewer_rules))
        writeNotes(
          {
            coach_notes: { recurring_gaps: list(body.coach_notes.recurring_gaps), getting_better: list(body.coach_notes.getting_better), drill_next: list(body.coach_notes.drill_next) },
            interviewer_rules: list(body.interviewer_rules),
          },
          r.session.id,
        );
      return r;
    }),
  );
  router.post('/api/sessions/:id/debrief', guard, handle((req) => startDebrief(id(req), { voice: req.body?.voice, turnTaking: req.body?.turnTaking })));
  router.post('/api/sessions/:id/debrief/end', handle((req) => saveDebrief(id(req), req.body || {})));
  router.use('/api', (_req, res) => {
    res.status(404).json({ error: 'No such API route' });
  });

  // The page. Its URLs are relative, so the root needs its trailing slash: /interview -> /interview/.
  router.get('/', opts.pageGuard ?? pass, (req, res) => {
    const urlPath = req.originalUrl.split('?')[0];
    if (!urlPath.endsWith('/')) return res.redirect(301, `${path.posix.basename(urlPath)}/`);
    if (!fs.existsSync(path.join(webDist, 'index.html')))
      return res.status(503).type('text/plain').send('The page is not built yet. Run "npm run build" in voice-interviewer, then reload.');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(webDist, 'index.html'));
  });
  router.use('/assets', express.static(path.join(webDist, 'assets'), { index: false, maxAge: '1h' }));

  if (opts.cleanup !== false) {
    const tidy = () => {
      try {
        const r = cleanupSessions();
        if (r.deleted.length || r.compacted.length) console.log(`[voice-interviewer] cleanup: deleted ${r.deleted.length} unanswered, compacted ${r.compacted.length}`);
      } catch (err) {
        console.error('[voice-interviewer] cleanup failed:', (err as Error).message);
      }
    };
    tidy();
    setInterval(tidy, 6 * 3600_000).unref();
  }
  return router;
}
