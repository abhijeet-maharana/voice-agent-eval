import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';

// Using an existing notes folder through `paths` and `skip` in config.json, and mounting the app under a
// prefix inside another Express app with a guard, the way an existing dashboard embeds it.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-interviewer-app-'));
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
// An existing repo layout: questions in qna/, the app's data in qna/mocks/, profile files elsewhere.
write('qna/0-screening/010-tell-me-about-yourself.md', '# Tell me about yourself\n\n## The Short Answer\nPresent, past, future.\n');
write('qna/0-screening/00-framework.md', '# Framework\n\nNotes, not a question.\n');
write('qna/8-dsa/010-two-sum.md', '# Two sum\n\nCode, not spoken.\n');
write('qna/interviews/acme.md', '# Acme · Engineer\n\nAcme ships trucks.\n');
write('resume/base_resume.md', '# Sam\n- Built the notifications service for 20,000 daily users\n');
write('about-me.md', 'Runs SecretCo on weekends, a side business.\n');
write(
  'qna/mocks/config.json',
  JSON.stringify({
    paths: { questions: '..', prep: '../interviews', profile: ['../../resume/base_resume.md', '../../about-me.md'], reports: '.' },
    skip: { folders: ['8-dsa', 'interviews', 'mocks'], files: '^00-' },
    privateWords: ['secretco'],
    reviewNotes: ['Never use a year in a rewrite.'],
    rounds: [{ id: 'screening', label: 'Screen', about: 'Intro.', mix: { '0-screening': 2 }, minutes: 10, followUps: 1, persona: 'recruiter', model: 'fast', job: 'optional' }],
  }),
);
Object.assign(process.env, { WORKSPACE: path.join(root, 'qna/mocks'), GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '' });

const { createInterviewApp } = await import('../src/app');
const bank = await import('../src/bank');
const ws = await import('../src/workspace');
const review = await import('../src/review');

test('paths and skip rules read an existing layout as it is', () => {
  assert.deepEqual(bank.loadBank().map((q) => q.id), ['0-screening/010-tell-me-about-yourself']);
  assert.equal(bank.loadBank()[0].short, 'Present, past, future.', '"The Short Answer" heading works too');
  assert.equal(ws.paths.reports(), path.join(root, 'qna/mocks'));
  assert.deepEqual(ws.listPrepPacks().map((p) => p.file), ['acme.md']);
  const profile = ws.profileTexts();
  assert.deepEqual(profile.map((p) => p.file), ['base_resume.md', 'about-me.md']);
  assert.ok(!JSON.stringify(profile).includes('SecretCo'), 'private words are dropped from listed files too');
  assert.match(review.systemPrompt(), /## Extra rules from the candidate\n- Never use a year in a rewrite\./);
});

test('mounted under a prefix: redirect to the trailing slash, API works, the guard protects every write and no read', async () => {
  const seen: string[] = [];
  const host = express();
  host.use(
    '/interview',
    createInterviewApp({
      cleanup: false,
      guard: (req, res, next) => {
        seen.push(req.path);
        if (req.headers['x-ok'] === '1') return next();
        res.status(401).json({ error: 'Not signed in', unlock: '/unlock' });
      },
    }),
  );
  const server = host.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const redirect = await fetch(`${base}/interview`, { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), 'interview/');

    const options = (await (await fetch(`${base}/interview/api/options`)).json()) as any;
    assert.equal(options.result.questionCount, 1);
    assert.deepEqual(options.result.rounds.map((r: { id: string }) => r.id), ['screening']);

    const blocked = await fetch(`${base}/interview/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"round":"screening"}' });
    assert.equal(blocked.status, 401);
    assert.deepEqual(await blocked.json(), { error: 'Not signed in', unlock: '/unlock' });

    const passed = await fetch(`${base}/interview/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ok': '1' }, body: '{"round":"screening"}' });
    assert.equal(passed.status, 503, 'past the guard, the missing Gemini key stops it');
    assert.match(((await passed.json()) as any).error, /GEMINI_API_KEY/);

    assert.equal((await fetch(`${base}/interview/api/nope`)).status, 404);
    const deleted = await fetch(`${base}/interview/api/sessions/2026-11-11-1000-screening`, { method: 'DELETE' });
    assert.equal(deleted.status, 401, 'deleting is guarded too');
    // Ending a call starts paid grading, and a posted review rewrites the notes files: both are writes.
    for (const route of ['end', 'tool', 'log', 'review', 'debrief/end']) {
      const r = await fetch(`${base}/interview/api/sessions/2026-11-11-1000-screening/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 401, `POST ${route} is guarded`);
    }
    assert.equal((await fetch(`${base}/interview/api/sessions/2026-11-11-1000-screening`)).status, 404, 'reads skip the guard');
    assert.deepEqual(seen, [
      '/api/sessions',
      '/api/sessions',
      '/api/sessions/2026-11-11-1000-screening',
      ...['end', 'tool', 'log', 'review', 'debrief/end'].map((r) => `/api/sessions/2026-11-11-1000-screening/${r}`),
    ]);
  } finally {
    server.close();
  }
});
