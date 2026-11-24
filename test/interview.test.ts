import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// The whole flow without a browser or real APIs: question bank, spaced repetition picks, the interviewer's
// tools, delivery metrics, the review that feeds progress.json and the report, and Claude grading with a
// fake client.

process.env.TZ = 'UTC';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-agent-eval-'));
Object.assign(process.env, { WORKSPACE: root, GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '' });

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const q = (title: string, short: string) => `# ${title}\n\n## Short Answer\n${short}\n\n## Going Deeper\nMore text.\n`;

write('questions/screening/010-tell-me-about-yourself.md', q('Tell me about yourself', 'Present, past, future in 90 seconds.'));
write('questions/screening/020-why-leave.md', q('Why are you leaving?', 'Growth, not complaints.'));
write('questions/screening/_playbook.md', q('A playbook', 'Not a question.'));
write('questions/screening/README.md', '# Readme\n');
for (let i = 1; i <= 5; i++) write(`questions/screening/0${i}5-extra-${i}.md`, q(`Extra screening ${i}`, `Answer ${i}.`));
write('questions/nodejs/010-event-loop.md', q('Explain the Node.js event loop', 'Phases: timers, poll, check; microtasks between callbacks.'));
write('questions/system-design/_framework.md', q('Framework', 'Notes.'));
write('questions/system-design/040-design-a-url-shortener.md', q('Design a URL shortener', 'Base62 ids, KV store, cache, 301 vs 302.'));
write('questions/system-design/020-cap-theorem.md', q('CAP theorem', 'Pick CP or AP under partitions.'));
write('questions/_drafts/010-x.md', q('Draft', 'Not ready.'));
write('prep/2026-11-10-acme.md', '# Acme · Senior Engineer\n\nAcme builds volunteer scheduling on Laravel and React.\nAcme also knows about Moonlight Labs.\n');
write('profile/resume.md', '# Sam\n- Built a shared React component library used across 5+ apps\n- Cut release cycles with CI pipelines (tests, lint, deploy)\n');
write('profile/about.md', 'Five years of full stack work with Node.js and TypeScript.\nRuns Moonlight Labs, a component library side business.\n');
write('config.json', JSON.stringify({ candidate: { name: 'Sam', summary: 'a senior full stack engineer.' }, privateWords: ['Moonlight'] }));

const m = await import('../src/sessions');
const bank = await import('../src/bank');
const cfg = await import('../src/workspace');
const review = await import('../src/review');
const NOW = new Date('2026-11-11T10:00:00Z');
const okFetch = (async () => new Response(JSON.stringify({ name: 'auth_tokens/abc' }), { status: 200 })) as unknown as typeof fetch;
const prompt = (live: { setup: { setup: unknown } }) => (live.setup.setup as any).systemInstruction.parts[0].text as string;

test('bank skips notes, READMEs and underscore folders', () => {
  const ids = bank.loadBank().map((b) => b.id);
  assert.ok(ids.includes('nodejs/010-event-loop'));
  assert.ok(!ids.some((id) => /README|_framework|_playbook|_drafts/.test(id)));
  const loop = bank.loadBank().find((b) => b.id === 'nodejs/010-event-loop')!;
  assert.equal(loop.question, 'Explain the Node.js event loop');
  assert.match(loop.short, /microtasks/);
  assert.equal(bank.questionFile('../x/y'), undefined);
  assert.equal(bank.questionFile('nodejs/../../etc'), undefined);
});

test('config: defaults, bad rounds are refused with a clear message', () => {
  assert.equal(cfg.loadConfig().candidate.name, 'Sam');
  assert.ok(cfg.loadConfig().rounds.some((r) => r.id === 'system-design'));
  write('config.json', JSON.stringify({ rounds: [{ id: 'Bad Id', label: 'x', mix: { a: 1 }, persona: 'cto', model: 'fast', job: 'none' }] }));
  assert.throws(() => cfg.loadConfig(), /round id "Bad Id"/);
  write('config.json', JSON.stringify({ rounds: [{ id: 'x', label: 'x', mix: { a: 1 }, persona: 'nobody', model: 'fast', job: 'none' }] }));
  assert.throws(() => cfg.loadConfig(), /unknown persona/);
  write('config.json', JSON.stringify({ candidate: { name: 'Sam', summary: 'a senior full stack engineer.' }, privateWords: ['Moonlight'] }));
});

test('picks due questions first, then fresh ones; system design only design questions', () => {
  const all = bank.loadBank();
  const screening = cfg.loadConfig().rounds.find((r) => r.id === 'screening')!;
  const progress = {
    'screening/020-why-leave': { asked: 1, scores: [4], lastAsked: '2026-11-09', nextDue: '2026-11-10', failStreak: 1 },
    'screening/010-tell-me-about-yourself': { asked: 1, scores: [9], lastAsked: '2026-11-09', nextDue: '2026-12-01', failStreak: 0 },
  };
  const picked = bank.pickQuestions(screening, all, progress, { now: NOW, rand: () => 0.5 });
  assert.equal(picked.length, 5);
  assert.equal(picked[0].id, 'screening/020-why-leave');
  assert.ok(!picked.some((p) => p.id === 'screening/010-tell-me-about-yourself'), 'not due, and fresh ones fill the round');
  const sd = bank.pickQuestions(cfg.loadConfig().rounds.find((r) => r.id === 'system-design')!, all, {}, { now: NOW });
  assert.deepEqual(sd.map((p) => p.id), ['system-design/040-design-a-url-shortener']);
});

test('a screening opens with the pitch, ends with the candidate questions, and titles lose reader notes', () => {
  const list = [
    { id: 'screening/070-questions-to-ask-the-recruiter', folder: 'screening', question: 'Do you have any questions for me?', short: '' },
    { id: 'screening/020-why-leave', folder: 'screening', question: 'Why leave?', short: '' },
    { id: 'screening/010-tell-me-about-yourself', folder: 'screening', question: 'Tell me about yourself', short: '' },
  ];
  const round = { ...cfg.loadConfig().rounds.find((r) => r.id === 'screening')!, mix: { screening: 3 } };
  const order = bank.pickQuestions(round, list, {}, { now: NOW, rand: () => 0.99 }).map((x) => x.id.split('/')[1]);
  assert.deepEqual(order, ['010-tell-me-about-yourself', '020-why-leave', '070-questions-to-ask-the-recruiter']);
  assert.equal(bank.parseQuestion('x', '010-a.md', '# Tell me about yourself (the 90 second pitch)\n\nx')!.question, 'Tell me about yourself');
  assert.equal(bank.parseQuestion('x', '010-a.md', '# Question: "Why remote?" (Guide)\n\nx')!.question, 'Why remote?');
});

test('spaced repetition intervals', () => {
  assert.equal(bank.nextDue(4, 0, NOW), '2026-11-12');
  assert.equal(bank.nextDue(4, 1, NOW), '2026-11-14');
  assert.equal(bank.nextDue(4, 5, NOW), '2026-11-18');
  assert.equal(bank.nextDue(7, 0, NOW), '2026-11-18');
  assert.equal(bank.nextDue(9, 0, NOW), '2026-12-02');
});

test('no Gemini key: the session does not start', async () => {
  await assert.rejects(m.startSession({ round: 'screening' }, { now: NOW }), /GEMINI_API_KEY/);
  assert.ok(!fs.existsSync(path.join(root, 'sessions')));
});

test('bad input is refused', async () => {
  process.env.GEMINI_API_KEY = 'k';
  await assert.rejects(m.startSession({ round: 'nope' }, { now: NOW, fetchImpl: okFetch }), /Unknown round/);
  await assert.rejects(m.startSession({ round: 'real' }, { now: NOW, fetchImpl: okFetch }), /prep pack/);
  await assert.rejects(m.startSession({ round: 'real', prepPack: '../secrets.md' }, { now: NOW, fetchImpl: okFetch }), /bad prep pack/);
  await assert.rejects(m.startSession({ round: 'screening', model: 'gpt' }, { now: NOW, fetchImpl: okFetch }), /Unknown model/);
  await assert.rejects(m.startSession({ round: 'tech', topic: '../etc' }, { now: NOW, fetchImpl: okFetch }), /Unknown topic/);
  await assert.rejects(m.startSession({ round: 'screening', topic: 'nodejs' }, { now: NOW, fetchImpl: okFetch }), /Unknown topic/, 'only rounds with topicPick');
  assert.throws(() => m.loadSession('../../etc/passwd'), /bad session id/);
});

let sessionId = '';

test('start: token from the server, setup with tools, plan saved, key never sent', async () => {
  process.env.GEMINI_API_KEY = 'k';
  let sent: any;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent = { headers: init.headers, body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({ name: 'auth_tokens/abc' }), { status: 200 });
  }) as unknown as typeof fetch;
  const { session, live } = await m.startSession({ round: 'real', prepPack: '2026-11-10-acme.md' }, { now: NOW, fetchImpl });
  sessionId = session.id;
  assert.equal(session.id, '2026-11-11-1000-real');
  assert.equal(live.token, 'auth_tokens/abc');
  assert.equal((sent.headers as Record<string, string>)['x-goog-api-key'], 'k');
  assert.equal(sent.body.uses, 1);
  const setup = live.setup.setup as any;
  assert.deepEqual(setup.tools[0].functionDeclarations.map((t: { name: string }) => t.name), ['next_question', 'reference_answer', 'candidate_background', 'job_context', 'record_note', 'related_question', 'end_interview']);
  assert.match(prompt(live), /job_context first/);
  assert.match(prompt(live), /Candidate: Sam, a senior full stack engineer\./);
  assert.equal(setup.model, 'models/gemini-3.8-live', 'the quick model by default');
  assert.ok(setup.tools[0].functionDeclarations.every((t: { behavior: string }) => t.behavior === 'BLOCKING'), 'the interview waits for every tool result');
  assert.equal(setup.generationConfig.thinkingConfig, undefined);
  assert.ok(!JSON.stringify(live).includes('"k"'), 'the API key never goes to the browser');
  assert.ok(fs.existsSync(path.join(root, `sessions/${session.id}.json`)));
  assert.ok(session.plan.length >= 3);
  const again = await m.startSession({ round: 'real', prepPack: '2026-11-10-acme.md' }, { now: NOW, fetchImpl: okFetch });
  assert.equal(again.session.id, '2026-11-11-1000-real-2', 'same minute, new id');
});

test('voice model: any round can pick extended thinking, which gets background tools and a thinking level', async () => {
  const sd = await m.startSession({ round: 'system-design', model: 'thinking' }, { now: new Date('2026-11-11T11:00:00Z'), fetchImpl: okFetch });
  const t = sd.live.setup.setup as any;
  assert.equal(t.model, 'models/gemini-3.8-live-extended-thinking');
  assert.ok(t.tools[0].functionDeclarations.every((d: { behavior: string }) => d.behavior === 'NON_BLOCKING'), 'it closes on BLOCKING tools (1007)');
  assert.deepEqual(t.generationConfig.thinkingConfig, { thinkingLevel: 'LOW' }, 'it closes without a thinking level (1007)');
  assert.match(prompt(sd.live), /wait silently for its result/, 'and is told to wait for each result');
  const fast = await m.startSession({ round: 'system-design' }, { now: new Date('2026-11-11T11:01:00Z'), fetchImpl: okFetch });
  const fastSetup = fast.live.setup.setup as any;
  assert.equal(fastSetup.model, 'models/gemini-3.8-live', 'quick by default');
  assert.ok(fastSetup.tools[0].functionDeclarations.every((d: { behavior: string }) => d.behavior === 'BLOCKING'), 'the quick model waits for every tool result');
  assert.doesNotMatch(prompt(fast.live), /wait silently for its result/);
  assert.equal(m.pageOptions(NOW).models.length, 2);
});

test('tools: questions in order, reference, background without private lines, job, notes, errors, all logged', () => {
  const first = m.runTool(sessionId, 'next_question', {});
  const r1 = first.result as any;
  assert.equal(r1.number, 1);
  const ref = m.runTool(sessionId, 'reference_answer', { question_id: r1.question_id }).result as any;
  assert.ok(ref.strong_answer_covers.length > 0);
  assert.match(JSON.stringify(m.runTool(sessionId, 'reference_answer', { question_id: '../../x' }).result), /not in this interview plan/);
  const bg = m.runTool(sessionId, 'candidate_background', { query: 'component library' }).result as any;
  assert.match(bg.matches[0], /component library/);
  assert.ok(!JSON.stringify(bg).includes('Moonlight'), 'private words never reach the interviewer');
  const job = JSON.stringify(m.runTool(sessionId, 'job_context', {}).result);
  assert.match(job, /Acme builds/);
  assert.ok(!job.includes('Moonlight'), 'prep packs are scrubbed too');
  m.runTool(sessionId, 'record_note', { question_id: r1.question_id, rating: 42, note: 'ok' });
  assert.match(m.runTool(sessionId, 'rm_rf', {}).error!, /Unknown tool/);
  const s = m.loadSession(sessionId);
  assert.equal(s.notes[0].rating, 10, 'rating clamped');
  assert.equal(s.toolCalls.length, 7);
  let last: any;
  for (let i = 0; i < s.plan.length; i++) last = m.runTool(sessionId, 'next_question', {}).result;
  assert.equal(last.done, true);
});

test('connection log from the page is saved and checked', () => {
  const r = m.appendLog(sessionId, [{ t: 1.23, event: 'socket open', detail: 'setup sent' }, { t: 'x', event: 'bad' }, { t: 2, event: '' }]);
  assert.equal(r.saved, 1);
  assert.deepEqual(m.loadSession(sessionId).debug, [{ t: 1.2, event: 'socket open', detail: 'setup sent' }]);
  assert.throws(() => m.appendLog(sessionId, 'nope'), /must be a list/);
});

test('delivery metrics from the transcript', () => {
  const metrics = m.measure([
    { who: 'interviewer', text: 'Tell me about yourself.', start: 0, end: 3 },
    { who: 'candidate', text: 'Um, basically I build backends. Sorry, sir. You know, I like Node.', start: 4, end: 34 },
  ]);
  assert.equal(metrics.candidateSeconds, 30);
  assert.equal(metrics.wordsPerMinute, 24);
  assert.equal(metrics.fillers['um / uh'], 1);
  assert.equal(metrics.fillers.basically, 1);
  assert.equal(metrics.fillers['you know'], 1);
  assert.equal(metrics.fillers.like, 1);
  assert.equal(metrics.sirMadam, 1);
  assert.equal(metrics.apologies, 1);
});

const reviewBody = (qid: string, question: string) => ({
  overall: 6,
  summary: 'Solid basics, thin on trade-offs.',
  answers: [
    { question_id: qid, question, score: 4, technical: 'Missed microtasks.', structure: 'No headline.', delivery: 'One filler.', rewrite: 'Node runs one thread.\nIt works in phases.', fix: 'Lead with the answer.' },
    { question_id: 'not/in-plan', question: 'x', score: 9, technical: '', structure: '', delivery: '', rewrite: '', fix: '' },
  ],
  delivery: 'Good pace.',
  next_focus: ['Answer first'],
});

test('end saves the transcript once; a review writes the report and progress once', () => {
  const transcript = [
    { who: 'interviewer', text: 'Explain the event loop.', start: 1, end: 4 },
    { who: 'candidate', text: 'Node runs callbacks in phases. Basically timers, poll and check.', start: 5, end: 25 },
    { who: 'hacker', text: 'dropped', start: 0, end: 1 },
  ];
  const ended = m.endSession(sessionId, { transcript, durationSeconds: 600 }, NOW);
  assert.equal(ended.session.status, 'ended');
  assert.equal(ended.session.transcript.length, 2);
  assert.equal(ended.gradable, true);
  assert.equal(m.endSession(sessionId, { transcript: [] }, NOW).note, 'already ended');
  assert.throws(() => m.runTool(sessionId, 'next_question', {}), /has ended/);

  const qid = ended.session.plan[0].id;
  const body = reviewBody(qid, ended.session.plan[0].question);
  const { report } = m.saveReview(sessionId, body, NOW);
  const md = fs.readFileSync(path.join(root, 'reports', `${sessionId}.md`), 'utf8');
  assert.ok(report.endsWith(`reports/${sessionId}.md`));
  assert.match(md, /overall \*\*6\/10\*\*/);
  assert.match(md, /> It works in phases\./);
  let progress = bank.readProgress();
  assert.deepEqual(progress[qid], { asked: 1, scores: [4], lastAsked: '2026-11-11', nextDue: '2026-11-12', failStreak: 1 });
  assert.ok(!progress['not/in-plan'], 'only planned questions count');
  m.saveReview(sessionId, body, NOW);
  progress = bank.readProgress();
  assert.equal(progress[qid].asked, 1, 'a re-posted review does not count twice');
  assert.equal(m.loadSession(sessionId).status, 'reviewed');
  assert.equal(m.pageOptions(NOW).sessions.find((x) => x.id === sessionId)?.overall, 6);
});

test('spoken debrief: needs a review, reads the review, keeps the transcript', async () => {
  const live = await m.startDebrief(sessionId, { fetchImpl: okFetch });
  const text = prompt(live);
  assert.match(text, /Overall 6 out of 10/);
  assert.match(text, /Stronger way to say it: Node runs one thread\. It works in phases\./, 'rewrite read as one line');
  assert.match(text, /mock interview/);
  assert.deepEqual((live.setup.setup as any).tools[0].functionDeclarations.map((t: { name: string }) => t.name), ['end_debrief']);

  const fresh = await m.startSession({ round: 'screening' }, { now: new Date(), fetchImpl: okFetch });
  await assert.rejects(m.startDebrief(fresh.session.id, { fetchImpl: okFetch }), /no review yet/);

  assert.deepEqual(m.saveDebrief(sessionId, { transcript: [] }), { saved: false });
  const r = m.saveDebrief(sessionId, { transcript: [{ who: 'interviewer', text: 'Overall six.', start: 0, end: 2 }, { who: 'candidate', text: 'Next.', start: 3, end: 4 }], durationSeconds: 90, voice: 'Charon' });
  assert.equal(r.debriefs, 1);
  const md = fs.readFileSync(path.join(root, 'reports', `${sessionId}.md`), 'utf8');
  assert.match(md, /## Spoken debriefs/);
  assert.match(md, /voice Charon/);
  const ids = m.listSessions().map((x) => x.id);
  assert.ok(ids.includes(sessionId));
  assert.ok(ids.includes(fresh.session.id), 'a live session from just now still shows');
});

test('related_question: a question from an answer replaces a planned one, at most twice, never in fixed rounds', async () => {
  const { session } = await m.startSession({ round: 'screening' }, { now: new Date('2026-11-11T12:00:00Z'), fetchImpl: okFetch });
  const id = session.id;
  const before = session.plan.length;
  m.runTool(id, 'next_question', {});
  const r1 = m.runTool(id, 'related_question', { topic: 'the Node event loop blocking' }).result as any;
  assert.equal(r1.found, true);
  assert.equal(r1.question_id, 'nodejs/010-event-loop');
  assert.equal(r1.number, 2, 'asked right after the current question');
  assert.equal(m.loadSession(id).plan.length, before, 'it replaced a planned question');
  assert.equal((m.runTool(id, 'related_question', { topic: 'zzz qqq' }).result as any).found, false);
  assert.equal((m.runTool(id, 'related_question', { topic: 'design a URL shortener' }).result as any).question_id, 'system-design/040-design-a-url-shortener');
  assert.match(m.runTool(id, 'related_question', { topic: 'CAP theorem' }).error!, /Already added 2/);

  const fixed = await m.startSession({ round: 'ai-screen' }, { now: new Date('2026-11-11T12:01:00Z'), fetchImpl: okFetch });
  assert.match(m.runTool(fixed.session.id, 'related_question', { topic: 'event loop' }).error!, /fixed questions/);
  assert.match(prompt(fixed.live), /Ask no follow ups/);
});

test('voices: picked from the 30, saved, unknown ones refused', async () => {
  const { session, live } = await m.startSession({ round: 'screening', voice: 'Sulafat' }, { now: new Date('2026-11-11T12:30:00Z'), fetchImpl: okFetch });
  assert.equal(session.voice, 'Sulafat');
  assert.equal((live.setup.setup as any).generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Sulafat');
  await assert.rejects(m.startSession({ round: 'screening', voice: 'Alexa' }, { now: NOW, fetchImpl: okFetch }), /Unknown voice/);
  assert.equal(m.pageOptions(NOW).voices.length, 30);
});

test('learning loop: coach and interviewer notes reach the next interviewer and coach', async () => {
  review.writeNotes(
    {
      coach_notes: { recurring_gaps: ['Answers under 30 seconds with no example (3 of 3 sessions)'], getting_better: ['Headline first since 2026-11-11'], drill_next: ['Tell me about yourself in 75 seconds'] },
      interviewer_rules: ['Never ask a follow up and the next main question in one turn.'],
    },
    sessionId,
    NOW,
  );
  const { live } = await m.startSession({ round: 'screening' }, { now: new Date('2026-11-11T13:00:00Z'), fetchImpl: okFetch });
  const text = prompt(live);
  assert.match(text, /Answers under 30 seconds with no example/);
  assert.match(text, /Tell me about yourself in 75 seconds/);
  assert.match(text, /Never ask a follow up and the next main question in one turn/);
  assert.ok(!text.includes('Headline first'), 'progress notes are for the coach, not the interviewer');
  const coach = await m.startDebrief(sessionId, { fetchImpl: okFetch });
  assert.match(prompt(coach), /Headline first since 2026-11-11/);
  const fixed = await m.startSession({ round: 'ai-screen' }, { now: new Date('2026-11-11T13:01:00Z'), fetchImpl: okFetch });
  assert.ok(!prompt(fixed.live).includes('Answers under 30 seconds'), 'a scripted screen does not probe');
});

test('grading: Claude output becomes the review and the notes; failures are saved for a retry', async () => {
  const { session } = await m.startSession({ round: 'screening' }, { now: new Date('2026-11-11T14:00:00Z'), fetchImpl: okFetch });
  const id = session.id;
  const first = (m.runTool(id, 'next_question', {}).result as any).question_id as string;
  m.endSession(id, { transcript: [{ who: 'interviewer', text: 'Why leave?', start: 0, end: 2 }, { who: 'candidate', text: 'I want more ownership.', start: 3, end: 9 }], durationSeconds: 60 });

  const input = review.reviewInput(m.loadSession(id));
  assert.match(input, /## Candidate profile/);
  assert.ok(!input.includes('Moonlight'), 'private words never reach the reviewer');
  assert.match(input, /Going Deeper/, 'the reviewer reads the whole question file');
  assert.match(review.reviewPrompt(id), /Reply with only a JSON object/);

  let request: any;
  const ok = {
    beta: {
      messages: {
        parse: async (params: unknown) => {
          request = params;
          return {
            stop_reason: 'end_turn',
            model: 'claude-test',
            parsed_output: {
              ...reviewBody(first, 'Why leave?'),
              coach_notes: { recurring_gaps: ['Short answers (2 sessions)'], getting_better: ['(none yet)'], drill_next: [] },
              interviewer_rules: ['Wait two seconds after "mhm" before speaking.'],
              interviewer_bugs: [],
            },
          };
        },
      },
    },
  } as any;
  const r = await review.gradeSession(id, ok);
  assert.equal(r.overall, 6);
  assert.equal(request.model, 'claude-opus-5-5');
  assert.equal(request.fallbacks, 'default');
  const s = m.loadSession(id);
  assert.equal(s.status, 'reviewed');
  assert.equal(s.review?.reviewer, 'claude-test');
  assert.equal(s.grading, undefined);
  const notes = fs.readFileSync(path.join(root, 'coach-notes.md'), 'utf8');
  assert.match(notes, /- Short answers \(2 sessions\)/);
  assert.ok(!notes.includes('(none yet)\n- '), 'placeholders are not notes');
  assert.match(fs.readFileSync(path.join(root, 'interviewer-notes.md'), 'utf8'), /Wait two seconds/);
  await assert.rejects(review.gradeSession(id, ok), /Already reviewed/);

  const other = await m.startSession({ round: 'screening' }, { now: new Date('2026-11-11T14:10:00Z'), fetchImpl: okFetch });
  m.endSession(other.session.id, { transcript: [{ who: 'candidate', text: 'Hello.', start: 0, end: 1 }], durationSeconds: 5 });
  const refusing = { beta: { messages: { parse: async () => ({ stop_reason: 'refusal', parsed_output: null, model: 'x' }) } } } as any;
  await assert.rejects(review.gradeSession(other.session.id, refusing), /declined/);
  const failed = m.loadSession(other.session.id);
  assert.match(failed.reviewError!, /declined/);
  assert.equal(failed.grading, undefined);
  assert.equal(failed.status, 'ended', 'still gradable later');
});

test('cleanup: unanswered sessions go after a day, old ones are compacted, reviewed ones stay', () => {
  const dir = path.join(root, 'sessions');
  const mk = (id: string, createdAt: string, extra: object) =>
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, round: 'screening', persona: 'recruiter', createdAt, status: 'ended', plan: [], notes: [], transcript: [], toolCalls: [{ at: createdAt, name: 'next_question', args: {}, result: { q: 1 }, ms: 1 }], ...extra }));
  mk('2026-09-01-1000-screening', '2026-09-01T04:30:00Z', { status: 'reviewed', review: { overall: 5 }, transcript: [{ who: 'candidate', text: 'hi', start: 0, end: 1 }], debug: [{ t: 0, event: 'x' }] });
  mk('2026-11-09-1000-screening', '2026-11-09T04:30:00Z', { status: 'live' });
  mk('2026-11-12-1000-screening', '2026-11-12T04:30:00Z', { status: 'live' });
  const r = m.cleanupSessions(new Date('2026-11-12T10:00:00Z'));
  assert.ok(r.deleted.includes('2026-11-09-1000-screening'));
  assert.ok(!r.deleted.includes('2026-11-12-1000-screening'), 'a fresh one stays');
  assert.ok(!r.deleted.includes(sessionId), 'reviewed sessions are never deleted');
  assert.ok(r.compacted.includes('2026-09-01-1000-screening'));
  const old = m.loadSession('2026-09-01-1000-screening');
  assert.equal(old.debug, undefined);
  assert.equal(old.toolCalls[0].result, undefined);
  assert.equal(old.transcript.length, 1);
});

test('learn mode: the tutor gets the answer, the page shows it, recall hides it, and only the explain-back is scored', async () => {
  await assert.rejects(m.startSession({ round: 'screening', mode: 'quiz' }, { now: NOW, fetchImpl: okFetch }), /Unknown mode/);
  const { session, live } = await m.startSession({ round: 'tech', mode: 'learn' }, { now: new Date('2026-11-11T15:00:00Z'), fetchImpl: okFetch });
  assert.equal(session.mode, 'learn');
  const tools = (live.setup.setup as any).tools[0].functionDeclarations.map((t: { name: string }) => t.name);
  assert.deepEqual(tools, ['next_question', 'reference_answer', 'candidate_background', 'job_context', 'show_diagram', 'start_recall', 'record_note', 'end_interview']);
  assert.match(prompt(live), /call show_diagram first/);
  assert.match(prompt(live), /warm, patient, encouraging tutor/);
  assert.match(prompt(live), /call start_recall/);
  assert.match(live.kickoff, /Start the lesson/);

  const id = session.id;
  assert.match(m.runTool(id, 'start_recall', { question_id: session.plan[0].id }).error!, /not a question you have asked/);
  const q = m.runTool(id, 'next_question', {}, new Date(), 12.34).result as any;
  assert.ok(q.answer.length > 0, 'the short answer');
  assert.match(q.notes, /Going Deeper/, 'the whole file for the study card');
  assert.ok(!q.notes.startsWith('# '), 'without the title');
  assert.match(JSON.stringify(m.runTool(id, 'reference_answer', { question_id: q.question_id }).result), /notes/);
  assert.match(m.runTool(id, 'related_question', { topic: 'event loop' }).error!, /learn mode/);
  // Diagrams: only for a question already asked, never empty or huge.
  const flow = 'flowchart LR\n  A["Timers"] --> B["Poll"] --> C["Check"]';
  assert.equal((m.runTool(id, 'show_diagram', { question_id: q.question_id, title: 'Loop phases', mermaid: flow }).result as any).shown, true);
  assert.match(m.runTool(id, 'show_diagram', { question_id: session.plan[1]?.id ?? 'x', title: 't', mermaid: flow }).error!, /not a question you have asked/);
  assert.match(m.runTool(id, 'show_diagram', { question_id: q.question_id, title: 't', mermaid: ' ' }).error!, /empty/);
  assert.match(m.runTool(id, 'show_diagram', { question_id: q.question_id, title: 't', mermaid: 'x'.repeat(m.MAX_DIAGRAM + 1) }).error!, /too big/);
  assert.equal((m.runTool(id, 'start_recall', { question_id: q.question_id }).result as any).ok, true);
  const s = m.loadSession(id);
  assert.equal(s.plan[0].recalled, true);
  assert.equal(s.toolCalls.find((c) => c.name === 'next_question')!.t, 12.3, 'tool calls keep the page clock');

  m.endSession(id, { transcript: [{ who: 'candidate', text: 'The event loop runs callbacks in phases.', start: 20, end: 30 }], durationSeconds: 60 });
  const input = review.reviewInput(m.loadSession(id));
  assert.match(input, /Mode: LEARN/);
  assert.match(input, /taught, then explained back/);
  assert.match(input, /\[0:12\] next_question/);
  assert.match(input, /return interviewer_rules exactly as the current rules/);

  // A lesson's review updates the coach notes but never the interviewer's rules (those go into real interviews).
  const rulesBefore = fs.readFileSync(path.join(root, 'interviewer-notes.md'), 'utf8');
  const tutorReview = {
    beta: {
      messages: {
        parse: async () => ({
          stop_reason: 'end_turn',
          model: 'claude-test',
          parsed_output: {
            overall: 7,
            summary: 'Good explain-back.',
            answers: [{ question_id: q.question_id, question: q.question, score: 7, technical: '', structure: '', delivery: '', rewrite: '', fix: '' }],
            delivery: '',
            next_focus: [],
            coach_notes: { recurring_gaps: ['Explain-backs skip the example (1 lesson)'], getting_better: [], drill_next: [] },
            interviewer_rules: ['Check in after every point.'],
            interviewer_bugs: [],
          },
        }),
      },
    },
  } as any;
  await review.gradeSession(id, tutorReview);
  assert.equal(fs.readFileSync(path.join(root, 'interviewer-notes.md'), 'utf8'), rulesBefore, 'interviewer rules untouched');
  assert.match(fs.readFileSync(path.join(root, 'coach-notes.md'), 'utf8'), /Explain-backs skip the example/);

  const plain = await m.startSession({ round: 'tech' }, { now: new Date('2026-11-11T15:05:00Z'), fetchImpl: okFetch });
  assert.equal(plain.session.mode, 'interview', 'interview by default');
  assert.match(m.runTool(plain.session.id, 'start_recall', { question_id: 'x' }).error!, /only for learn mode/);
  assert.match(m.runTool(plain.session.id, 'show_diagram', { question_id: 'x', title: 't', mermaid: 'flowchart LR' }).error!, /only for learn mode/);

  // End without review: saved, not gradable, and a review posted later clears the flag.
  const skipped = await m.startSession({ round: 'tech' }, { now: new Date('2026-11-11T15:10:00Z'), fetchImpl: okFetch });
  const ended = m.endSession(skipped.session.id, { transcript: [{ who: 'candidate', text: 'An answer.', start: 0, end: 5 }], durationSeconds: 30, skipReview: true });
  assert.equal(ended.gradable, false);
  assert.equal(ended.note, 'saved, review skipped');
  assert.equal(m.loadSession(skipped.session.id).reviewSkipped, true);
  const sq = skipped.session.plan[0];
  m.saveReview(skipped.session.id, { answers: [{ question_id: sq.id, question: sq.question, score: 6 }] });
  assert.equal(m.loadSession(skipped.session.id).reviewSkipped, undefined, 'grading it later clears the flag');
});

test('generic rounds: per round instructions reach the interviewer, review focus reaches the reviewer, defaultMode applies', async () => {
  const comm = cfg.loadConfig().rounds.find((r) => r.id === 'communication')!;
  assert.ok(comm.reviewFocus && comm.instructions, 'a communication round ships by default');
  const { session, live } = await m.startSession({ round: 'communication' }, { now: new Date('2026-11-11T16:00:00Z'), fetchImpl: okFetch });
  assert.match(prompt(live), /For this round: If an answer rambles/);
  m.endSession(session.id, { transcript: [{ who: 'candidate', text: 'Hi.', start: 0, end: 1 }], durationSeconds: 5 });
  assert.match(review.reviewInput(m.loadSession(session.id)), /Focus for this round: This is a communication round/);

  write('config.json', JSON.stringify({ candidate: { name: 'Sam', summary: 'a senior full stack engineer.' }, privateWords: ['Moonlight'], defaultMode: 'learn' }));
  const learned = await m.startSession({ round: 'screening' }, { now: new Date('2026-11-11T16:01:00Z'), fetchImpl: okFetch });
  assert.equal(learned.session.mode, 'learn');
  assert.equal(learned.session.voice, 'Erinome', 'learn mode gets the clear tutor voice by default');
  assert.match(prompt(learned.live), /never sound strict/);
  assert.match(prompt(learned.live), /about 140 words per minute/);
  assert.equal(m.pageOptions(NOW).defaultMode, 'learn');
  write('config.json', JSON.stringify({ candidate: { name: 'Sam', summary: 'a senior full stack engineer.' }, privateWords: ['Moonlight'], accent: 'Indian' }));
  const accented = await m.startSession({ round: 'screening' }, { now: new Date('2026-11-11T16:02:00Z'), fetchImpl: okFetch });
  assert.match(prompt(accented.live), /natural Indian English accent/);
  assert.match(prompt(accented.live), /Speak only English for the whole interview/);
  write('config.json', JSON.stringify({ candidate: { name: 'Sam', summary: 'a senior full stack engineer.' }, privateWords: ['Moonlight'], accent: 'Indian', secondLanguage: 'Hindi' }));
  const hinglish = await m.startSession({ round: 'screening', mode: 'learn' }, { now: new Date('2026-11-11T16:04:00Z'), fetchImpl: okFetch });
  assert.match(prompt(hinglish.live), /If they speak Hindi .*\(Hinglish\).*every technical term and keyword in English/);
  const strict = await m.startSession({ round: 'screening' }, { now: new Date('2026-11-11T16:05:00Z'), fetchImpl: okFetch });
  assert.doesNotMatch(prompt(strict.live), /Hinglish/, 'the interview itself stays in English');
  write('config.json', JSON.stringify({ candidate: { name: 'Sam', summary: 'a senior full stack engineer.' }, privateWords: ['Moonlight'] }));
  assert.doesNotMatch(prompt((await m.startSession({ round: 'screening' }, { now: new Date('2026-11-11T16:03:00Z'), fetchImpl: okFetch })).live), /accent/, 'no accent line by default');
});

test('turn taking: auto waits for the chosen pause, button turns detection off, bad values refused', async () => {
  const auto = await m.startSession({ round: 'screening', turnTaking: { mode: 'auto', pauseMs: 6000 } }, { now: new Date('2026-11-11T17:00:00Z'), fetchImpl: okFetch });
  const ac = (auto.live.setup.setup as any).realtimeInputConfig;
  assert.deepEqual(ac.automaticActivityDetection, { disabled: false, endOfSpeechSensitivity: 'END_SENSITIVITY_LOW', silenceDurationMs: 6000 });
  assert.match(prompt(auto.live), /A pause is not the end of an answer/);
  assert.deepEqual(auto.session.turnTaking, { mode: 'auto', pauseMs: 6000 });

  const button = await m.startSession({ round: 'screening', turnTaking: { mode: 'button' } }, { now: new Date('2026-11-11T17:01:00Z'), fetchImpl: okFetch });
  assert.equal((button.live.setup.setup as any).realtimeInputConfig.automaticActivityDetection.disabled, true);
  assert.match(prompt(button.live), /presses a Done button/);

  const dflt = await m.startSession({ round: 'screening' }, { now: new Date('2026-11-11T17:02:00Z'), fetchImpl: okFetch });
  assert.equal((dflt.live.setup.setup as any).realtimeInputConfig.automaticActivityDetection.silenceDurationMs, 3000, 'auto, 3 s by default');

  await assert.rejects(m.startSession({ round: 'screening', turnTaking: { mode: 'push' } }, { now: NOW, fetchImpl: okFetch }), /turnTaking.mode/);
  await assert.rejects(m.startSession({ round: 'screening', turnTaking: { mode: 'auto', pauseMs: 60_000 } }, { now: NOW, fetchImpl: okFetch }), /pauseMs/);
  const coach = await m.startDebrief(sessionId, { fetchImpl: okFetch, turnTaking: { mode: 'button' } });
  assert.equal((coach.setup.setup as any).realtimeInputConfig.automaticActivityDetection.disabled, true, 'the spoken review follows the same choice');
  assert.equal((coach.setup.setup as any).tools[0].functionDeclarations[0].behavior, 'BLOCKING', 'the spoken review stays on the quick model');
});

test('question bank: every question with its answer, and calls on hand picked questions', async () => {
  const list = m.questionList(NOW);
  const loop = list.find((q) => q.id === 'nodejs/010-event-loop')!;
  assert.equal(loop.question, 'Explain the Node.js event loop');
  assert.match(loop.short, /microtasks/);
  assert.ok(!list.some((q) => /Moonlight/.test(q.short)), 'private words never reach the page');
  assert.match(m.questionNotes('nodejs/010-event-loop').notes, /Going Deeper/);
  assert.throws(() => m.questionNotes('../etc/passwd'), /No such question/);

  const picked = ['system-design/020-cap-theorem', 'nodejs/010-event-loop'];
  const { session } = await m.startSession({ questions: picked, mode: 'learn' }, { now: new Date('2026-11-11T19:30:00Z'), fetchImpl: okFetch });
  assert.deepEqual(session.plan.map((p) => p.id), picked, 'asked in the order picked');
  assert.equal(session.picked, true);
  assert.equal(session.round, 'tech', 'the round whose folders hold most of the picked questions (nodejs and system-design)');
  const one = await m.startSession({ questions: ['nodejs/010-event-loop'], round: 'screening' }, { now: new Date('2026-11-11T19:31:00Z'), fetchImpl: okFetch });
  assert.equal(one.session.round, 'screening', 'a round sent with the questions wins');
  assert.equal(one.session.plan.length, 1);

  await assert.rejects(m.startSession({ questions: ['nodejs/nope'] }, { now: NOW, fetchImpl: okFetch }), /Unknown question/);
  await assert.rejects(m.startSession({ questions: [] }, { now: NOW, fetchImpl: okFetch }), /1 to 10/);
  await assert.rejects(m.startSession({ questions: Array.from({ length: 11 }, () => 'nodejs/010-event-loop') }, { now: NOW, fetchImpl: okFetch }), /1 to 10/);
});

test('delete: the session and its report go, and progress is rebuilt without it', async () => {
  const { session } = await m.startSession({ round: 'screening' }, { now: new Date('2026-11-11T18:00:00Z'), fetchImpl: okFetch });
  const id = session.id;
  m.runTool(id, 'next_question', {});
  m.endSession(id, { transcript: [{ who: 'candidate', text: 'An answer.', start: 0, end: 5 }], durationSeconds: 30 });
  const qid = session.plan[0].id;
  const before = bank.readProgress()[qid]?.asked ?? 0;
  m.saveReview(id, { overall: 3, summary: 's', answers: [{ question_id: qid, question: 'q', score: 3, technical: '', structure: '', delivery: '', rewrite: '', fix: '' }], delivery: '', next_focus: [] }, new Date('2026-11-11T18:30:00Z'));
  assert.equal(bank.readProgress()[qid].asked, before + 1);
  assert.ok(fs.existsSync(path.join(root, 'reports', `${id}.md`)));

  const r = m.deleteSession(id);
  assert.equal(r.deleted, id);
  assert.ok(!fs.existsSync(path.join(root, 'sessions', `${id}.json`)));
  assert.ok(!fs.existsSync(path.join(root, 'reports', `${id}.md`)));
  assert.equal(bank.readProgress()[qid]?.asked ?? 0, before, 'its answers no longer count');
  assert.ok(m.loadSession(sessionId).review, 'other sessions stay');
  assert.ok(bank.readProgress()[m.loadSession(sessionId).review!.answers[0].question_id], 'and keep their progress');
  assert.throws(() => m.deleteSession(id), /No session/);
  assert.throws(() => m.deleteSession('../../etc/passwd'), /bad session id/);
});

test('restart: a grading flag left by a restart becomes an error the page can retry', async () => {
  const { session } = await m.startSession({ round: 'screening' }, { now: new Date('2026-11-11T19:00:00Z'), fetchImpl: okFetch });
  m.endSession(session.id, { transcript: [{ who: 'candidate', text: 'An answer.', start: 0, end: 5 }], durationSeconds: 30 });
  const s = m.loadSession(session.id);
  s.grading = { startedAt: '2026-11-11T19:01:00Z' };
  m.saveSession(s);
  assert.deepEqual(m.recoverGrading(15 * 60_000, new Date('2026-11-11T19:05:00Z')), [], 'a recent one may still be running');
  assert.deepEqual(m.recoverGrading(), [session.id]);
  const after = m.loadSession(session.id);
  assert.equal(after.grading, undefined);
  assert.match(after.reviewError!, /interrupted/);
  assert.equal(after.status, 'ended', 'still gradable');
});

test('priority: must-know questions come first in the bank and in fresh picks; topicOrder orders folders', () => {
  const qp = (title: string, p: number | null) => `# ${title}\n\n${p ? `**Priority:** ${p} (note)\n\n` : ''}## Short Answer\nx\n`;
  write('questions/react/010-advanced.md', qp('Advanced react', 3));
  write('questions/react/020-common.md', qp('Common react', null));
  write('questions/react/030-must.md', qp('Must react', 1));
  write('questions/react/040-must-too.md', qp('Must react too', 1));
  const before = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
  write('config.json', JSON.stringify({ ...JSON.parse(before), topicOrder: ['react', 'nodejs'] }));
  try {
    const all = bank.loadBank();
    const react = all.filter((q) => q.folder === 'react');
    assert.deepEqual(react.map((q) => q.priority), [1, 1, 2, 3], 'parsed, default 2, sorted');
    const noShort = bank.parseQuestion('x', '010-a.md', '# Tell me about yourself\n\n**Priority:** 1 (must know)\n\n> I build web apps.\n');
    assert.equal(noShort!.short, '> I build web apps.', 'the priority line is never taken as the answer');
    assert.deepEqual(bank.topicFolders(all).slice(0, 2), ['react', 'nodejs'], 'topicOrder first, the rest after');
    const round = { ...cfg.loadConfig().rounds.find((r) => r.id === 'tech')!, mix: { react: 2 } };
    for (const r of [0, 0.5, 0.99]) {
      const ids = bank.pickQuestions(round, all, {}, { now: NOW, rand: () => r }).map((x) => x.id);
      assert.deepEqual([...ids].sort(), ['react/030-must', 'react/040-must-too'], 'both must-know before anything else');
    }
    const progress = { 'react/030-must': { asked: 1, scores: [9], lastAsked: '2026-11-09', nextDue: '2026-12-01', failStreak: 0 } };
    const next = bank.pickQuestions(round, all, progress, { now: NOW, rand: () => 0.5 }).map((x) => x.id);
    assert.deepEqual(next, ['react/040-must-too', 'react/020-common'], 'an answered one waits; common comes before advanced');
  } finally {
    write('config.json', before);
  }
});
