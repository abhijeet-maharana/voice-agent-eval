import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import { gradeSession, gradingConfigured, reviewPrompt, writeNotes } from './review';
import { appendLog, cleanupSessions, endSession, loadSession, pageOptions, runTool, saveDebrief, saveReview, startDebrief, startSession } from './sessions';
import { HttpError, workspaceDir } from './workspace';

/**
 * The local server: the web page (web/dist), the session API the page calls, and grading after each call.
 * It binds to 127.0.0.1 by default. The microphone works on localhost without HTTPS; there is no login,
 * so do not expose it on a network.
 */

const PORT = Number(process.env.PORT || 4747);
const HOST = process.env.HOST || '127.0.0.1';
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.join(here, '..', 'web', 'dist');

const app = express();
app.use(express.json({ limit: '4mb' }));

type Handler = (req: Request) => unknown | Promise<unknown>;
const handle = (fn: Handler) => async (req: Request, res: Response) => {
  try {
    res.json({ result: await fn(req) });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(`[api] ${req.method} ${req.path}:`, (err as Error).message);
    res.status(status).json({ error: (err as Error).message });
  }
};
const id = (req: Request) => String(req.params.id);

/** Starts grading in the background; the page polls the session until the review lands. */
function gradeLater(sessionId: string) {
  if (!gradingConfigured()) return 'not configured: set ANTHROPIC_API_KEY, or grade by hand with the review prompt';
  gradeSession(sessionId).then(
    (r) => console.log(`[review] ${sessionId}: ${r.overall}/10, ${r.report}${r.bugs.length ? `; interviewer bugs: ${r.bugs.join(' | ')}` : ''}`),
    (err) => console.error(`[review] ${sessionId} failed: ${(err as Error).message}`),
  );
  return 'grading';
}

app.get('/api/options', handle(() => pageOptions(new Date(), gradingConfigured())));
app.post('/api/sessions', handle((req) => startSession(req.body || {})));
app.get('/api/sessions/:id', handle((req) => loadSession(id(req))));
app.post('/api/sessions/:id/tool', handle((req) => runTool(id(req), String(req.body?.name ?? ''), req.body?.args && typeof req.body.args === 'object' ? req.body.args : {})));
app.post('/api/sessions/:id/log', handle((req) => appendLog(id(req), req.body?.entries)));
app.post(
  '/api/sessions/:id/end',
  handle((req) => {
    const r = endSession(id(req), req.body || {});
    return { session: r.session, review: r.gradable ? gradeLater(r.session.id) : r.note };
  }),
);
app.post(
  '/api/sessions/:id/grade',
  handle((req) => {
    const s = loadSession(id(req));
    if (s.review) throw new HttpError(409, 'Already reviewed');
    if (s.grading && Date.now() - Date.parse(s.grading.startedAt) < 10 * 60_000) throw new HttpError(409, 'Already grading');
    return { review: gradeLater(s.id) };
  }),
);
app.get('/api/sessions/:id/review-prompt', (req, res) => {
  try {
    res.type('text/plain').send(reviewPrompt(id(req)));
  } catch (err) {
    res.status(err instanceof HttpError ? err.status : 500).type('text/plain').send((err as Error).message);
  }
});
// A review graded elsewhere (the JSON a Claude chat returned for the review prompt).
app.post(
  '/api/sessions/:id/review',
  handle((req) => {
    const body = req.body || {};
    const r = saveReview(id(req), body);
    if (body.coach_notes && Array.isArray(body.interviewer_rules))
      writeNotes(
        {
          coach_notes: {
            recurring_gaps: Array.isArray(body.coach_notes.recurring_gaps) ? body.coach_notes.recurring_gaps.map(String) : [],
            getting_better: Array.isArray(body.coach_notes.getting_better) ? body.coach_notes.getting_better.map(String) : [],
            drill_next: Array.isArray(body.coach_notes.drill_next) ? body.coach_notes.drill_next.map(String) : [],
          },
          interviewer_rules: body.interviewer_rules.map(String),
        },
        r.session.id,
      );
    return r;
  }),
);
app.post('/api/sessions/:id/debrief', handle((req) => startDebrief(id(req), { voice: req.body?.voice })));
app.post('/api/sessions/:id/debrief/end', handle((req) => saveDebrief(id(req), req.body || {})));

app.use('/api', (_req, res) => res.status(404).json({ error: 'No such API route' }));

if (fs.existsSync(path.join(webDist, 'index.html'))) {
  app.use(express.static(webDist));
  app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
} else {
  app.get('/', (_req, res) => res.type('text/plain').send('The page is not built yet. Run "npm run build", then restart, or use "npm run dev:web" for development.'));
}

function cleanup() {
  try {
    const r = cleanupSessions();
    if (r.deleted.length || r.compacted.length) console.log(`[cleanup] deleted ${r.deleted.length} unanswered, compacted ${r.compacted.length}`);
  } catch (err) {
    console.error('[cleanup] failed:', (err as Error).message);
  }
}
cleanup();
setInterval(cleanup, 6 * 3600_000).unref();

app.listen(PORT, HOST, () => {
  const local = HOST === '0.0.0.0' || HOST === '127.0.0.1' ? 'localhost' : HOST;
  console.log(`voice-interviewer on http://${local}:${PORT}`);
  console.log(`  workspace: ${workspaceDir()}${fs.existsSync(workspaceDir()) ? '' : ' (missing: run "npm run setup")'}`);
  console.log(`  live interviewer: ${process.env.GEMINI_API_KEY ? 'on' : 'off (set GEMINI_API_KEY in .env)'}`);
  console.log(`  grading with Claude: ${gradingConfigured() ? 'on' : 'off (set ANTHROPIC_API_KEY in .env, or grade by hand)'}`);
});
