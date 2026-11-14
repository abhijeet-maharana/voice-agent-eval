import fs from 'node:fs';
import path from 'node:path';
import { CLOSER, DEFAULT_PRIORITY, MAX_ADDED, bankEntry, dayKey, loadBank, nextDue, pickQuestions, questionFile, readProgress, relatedQuestion, topicFolders, words } from './bank';
import { DEBRIEF_TOOLS, LEARN_TOOLS, TOOLS, VOICES, debriefInstruction, learnInstruction, liveConfig, liveModels, liveSetup, mintToken, pickTurnTaking, pickVoice, systemInstruction } from './interviewer';
import type { BankQuestion, LiveModelId, Metrics, Mode, Progress, Review, ReviewAnswer, Round, Session, ToolCall, TranscriptTurn } from './types';
import { HttpError, listPrepPacks, loadConfig, paths, profileTexts, readJson, readPrepPack, requireWorkspace, scrub, writeJson, writeText } from './workspace';

/**
 * One mock interview, start to finish:
 *   1. startSession picks the questions, saves the plan and hands the browser a Gemini token and setup.
 *   2. The interviewer calls tools (runTool); the page shows every call with its arguments and result.
 *   3. endSession saves the transcript and measures delivery (pace, fillers).
 *   4. Claude grades it (review.ts) and saveReview writes the report and updates progress.json.
 *   5. Optional: a coach voice talks the candidate through the review (startDebrief / saveDebrief).
 */

const sessionFile = (id: string) => path.join(paths.sessions(), `${id}.json`);
export const reportFile = (id: string) => path.join(paths.reports(), `${id}.md`);

const SESSION_ID = /^\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9-]+$/;

export function loadSession(id: string): Session {
  if (!SESSION_ID.test(id)) throw new HttpError(400, 'bad session id');
  const s = readJson<Session | null>(sessionFile(id), null);
  if (!s) throw new HttpError(404, `No session ${id}`);
  return s;
}

export const saveSession = (s: Session) => writeJson(sessionFile(s.id), s);

export function listSessions() {
  const dir = paths.sessions();
  if (!fs.existsSync(dir)) return [];
  return (
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, 50)
      .map((f) => readJson<Session | null>(path.join(dir, f), null))
      .filter((s): s is Session => !!s)
      // Sessions with no answer (a failed start, a closed tab) are not history.
      .filter((s) => (s.status === 'live' ? Date.now() - Date.parse(s.createdAt) < 2 * 3600_000 : s.transcript.some((t) => t.who === 'candidate')))
      .map((s) => ({
        id: s.id,
        round: s.round,
        persona: s.persona,
        model: s.model,
        createdAt: s.createdAt,
        status: s.status,
        durationSeconds: s.durationSeconds,
        overall: s.review?.overall,
        mode: s.mode ?? 'interview',
        picked: !!s.picked,
        grading: !!s.grading,
        gradingFailed: !!s.reviewError,
        questions: s.plan.length,
        debriefs: s.debriefs?.length ?? 0,
      }))
  );
}

/** Local time stamp for ids and file names, e.g. 2026-11-14-1930. */
function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// ---------- Start ----------

export interface StartInput {
  round?: string;
  persona?: string;
  topic?: string;
  prepPack?: string;
  /** `fast` or `thinking`; default: the round's. */
  model?: string;
  /** A VOICES name; default GEMINI_LIVE_VOICE (Kore), or GEMINI_LIVE_TUTOR_VOICE (Sulafat) in learn mode. */
  voice?: string;
  /** `interview` or `learn`; default: config.json defaultMode. */
  mode?: string;
  /** `{ mode: 'auto', pauseMs }` or `{ mode: 'button' }`; default auto, 3 seconds. */
  turnTaking?: unknown;
  /** Question ids picked on the question bank page (1 to MAX_PICKED), asked in this order instead of the round's mix. */
  questions?: unknown;
}

/** At most this many questions can be picked by hand for one call. */
export const MAX_PICKED = 10;

/** The picked questions, checked against the bank; undefined when none were picked. */
function pickedQuestions(v: unknown, bank: BankQuestion[]): BankQuestion[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.length || v.length > MAX_PICKED) throw new HttpError(400, `questions must be a list of 1 to ${MAX_PICKED} question ids`);
  const byId = new Map(bank.map((q) => [q.id, q]));
  return [...new Set(v.map(String))].map((id) => {
    const q = byId.get(id);
    if (!q) throw new HttpError(400, `Unknown question: ${id}`);
    return q;
  });
}

/**
 * The round for hand picked questions (its persona, length and follow ups): the one whose folders hold most
 * of them, else one with a topic pick, never one that needs a prep pack.
 */
function roundFor(rounds: Round[], picked: BankQuestion[]): Round | undefined {
  const open = rounds.filter((r) => r.job !== 'required');
  const fit = (r: Round) => picked.filter((q) => q.folder in r.mix).length;
  const best = open.reduce<Round | undefined>((a, r) => (fit(r) > (a ? fit(a) : 0) ? r : a), undefined);
  return best ?? open.find((r) => r.topicPick) ?? open[0] ?? rounds[0];
}

export async function startSession(input: StartInput, opts: { now?: Date; fetchImpl?: typeof fetch } = {}) {
  requireWorkspace();
  const config = loadConfig();
  const bank = loadBank();
  const picked = pickedQuestions(input.questions, bank);
  const round = picked && !input.round ? roundFor(config.rounds, picked) : config.rounds.find((r) => r.id === input.round);
  if (!round) throw new HttpError(400, `Unknown round. Pick one of: ${config.rounds.map((r) => r.id).join(', ')}`);
  const persona = input.persona && config.personas[input.persona] ? input.persona : round.persona;
  if (round.job === 'required' && !input.prepPack) throw new HttpError(400, 'This round needs a prep pack');
  if (input.prepPack) readPrepPack(input.prepPack);
  if (input.topic && (!round.topicPick || !topicFolders(bank).includes(input.topic))) throw new HttpError(400, 'Unknown topic');
  const models = liveModels();
  if (input.model && !(input.model in models)) throw new HttpError(400, `Unknown model. Pick one of: ${Object.keys(models).join(', ')}`);
  if (input.mode && input.mode !== 'interview' && input.mode !== 'learn') throw new HttpError(400, 'Unknown mode. Pick interview or learn');
  const mode: Mode = (input.mode as Mode | undefined) ?? config.defaultMode;
  const modelChoice = (input.model as LiveModelId | undefined) ?? round.model;
  const voice = pickVoice(input.voice, mode === 'learn' ? liveConfig().tutorVoice : liveConfig().voice);
  const turnTaking = pickTurnTaking(input.turnTaking);
  const now = opts.now ?? new Date();
  const questions = picked ?? pickQuestions(round, bank, readProgress(), { topic: input.topic, now });
  if (!questions.length) throw new HttpError(400, `No questions for the ${round.label} round. Add files to ${Object.keys(round.mix).map((f) => `questions/${f}/`).join(', ')}`);
  const token = await mintToken(round.minutes, opts.fetchImpl);
  let id = `${stamp(now)}-${round.id}`;
  for (let n = 2; fs.existsSync(sessionFile(id)); n++) id = `${stamp(now)}-${round.id}-${n}`;
  const session: Session = {
    id,
    round: round.id,
    persona,
    topic: input.topic,
    prepPack: input.prepPack,
    mode,
    modelChoice,
    model: models[modelChoice].model,
    voice,
    turnTaking,
    ...(picked ? { picked: true } : {}),
    createdAt: now.toISOString(),
    status: 'live',
    plan: questions.map((q) => ({ id: q.id, question: q.question, asked: false })),
    toolCalls: [],
    notes: [],
    transcript: [],
  };
  saveSession(session);
  const asyncTools = { thinking: modelChoice === 'thinking' };
  const setup =
    mode === 'learn'
      ? liveSetup(session.model!, learnInstruction(session, round, config), LEARN_TOOLS, voice, turnTaking, asyncTools)
      : liveSetup(session.model!, systemInstruction(session, round, config), TOOLS, voice, turnTaking, asyncTools);
  const kickoff = mode === 'learn' ? '(The candidate has joined the call. Start the lesson now.)' : '(The candidate has joined the call. Start the interview now.)';
  return { session, live: { wsUrl: liveConfig().wsUrl, token, setup, kickoff } };
}

// ---------- Tool calls ----------

/** Lines of the profile files and the prep pack that share the most words with the query (private lines are already gone). */
export function searchBackground(query: string, prepPack?: string): string[] {
  const sources = profileTexts().map((p) => p.text);
  if (prepPack) sources.push(readPrepPack(prepPack));
  const terms = new Set(words(query));
  if (!terms.size) return [];
  const scored: { line: string; score: number }[] = [];
  for (const text of sources)
    for (const raw of text.split('\n')) {
      const line = raw.replace(/^[\s>*#|-]+/, '').trim();
      if (line.length < 20) continue;
      const score = words(line).filter((w) => terms.has(w)).length;
      if (score) scored.push({ line: line.slice(0, 300), score });
    }
  const seen = new Set<string>();
  return scored
    .sort((a, b) => b.score - a.score)
    .filter((s) => !seen.has(s.line) && seen.add(s.line))
    .slice(0, 8)
    .map((s) => s.line);
}

/** A question file's text for the lesson: everything after the title, private lines dropped, capped. */
export function lessonNotes(id: string): string {
  const file = questionFile(id);
  if (!file) return '';
  const text = scrub(fs.readFileSync(file, 'utf8'));
  return text.replace(/^[\s\S]*?^# .+$\n?/m, '').trim().slice(0, 6000);
}

/** Runs one tool call from the live voice. `t`: seconds since the session started, on the page's clock. */
export function runTool(id: string, name: string, args: Record<string, unknown>, now = new Date(), t?: number): ToolCall {
  const s = loadSession(id);
  if (s.status !== 'live') throw new HttpError(409, 'This session has ended');
  const started = Date.now();
  let result: unknown;
  let error: string | undefined;
  const planned = (qid: unknown) => s.plan.find((p) => p.id === qid);
  const learn = s.mode === 'learn';
  try {
    switch (name) {
      case 'next_question': {
        const i = s.plan.findIndex((p) => !p.asked);
        if (i < 0) {
          result = { done: true, message: 'All planned questions are done. Close the interview in one or two sentences, then call end_interview.' };
          break;
        }
        s.plan[i].asked = true;
        result = { done: false, number: i + 1, of: s.plan.length, question_id: s.plan[i].id, question: s.plan[i].question };
        // The lesson: the answer goes to the tutor and onto the candidate's screen.
        if (learn) result = { ...(result as object), answer: bankEntry(s.plan[i].id)?.short || 'No answer on file.', notes: lessonNotes(s.plan[i].id) };
        break;
      }
      case 'reference_answer': {
        const q = planned(args.question_id);
        if (!q) throw new Error('question_id is not in this interview plan');
        result = learn
          ? { question: q.question, notes: lessonNotes(q.id) || 'No notes on file.' }
          : { question: q.question, strong_answer_covers: bankEntry(q.id)?.short || 'No reference answer on file.' };
        break;
      }
      case 'start_recall': {
        if (!learn) throw new Error('start_recall is only for learn mode');
        const q = planned(args.question_id);
        if (!q || !q.asked) throw new Error('question_id is not a question you have asked');
        q.recalled = true;
        result = { ok: true, message: 'The answer is hidden on their screen now. Ask them to explain it back in their own words, and do not help while they do.' };
        break;
      }
      case 'candidate_background': {
        const lines = searchBackground(String(args.query ?? ''), s.prepPack);
        result = lines.length ? { matches: lines } : { matches: [], message: 'Nothing on file matches. Ask the candidate directly.' };
        break;
      }
      case 'job_context': {
        result = s.prepPack ? { prep_pack: readPrepPack(s.prepPack).slice(0, 6000) } : { message: 'No company attached. This is general practice: present yourself as a generic company.' };
        break;
      }
      case 'record_note': {
        if (!planned(args.question_id)) throw new Error('question_id is not in this interview plan');
        const rating = Math.max(1, Math.min(10, Math.round(Number(args.rating) || 0)));
        s.notes.push({ question_id: String(args.question_id), rating, note: String(args.note ?? '').slice(0, 500), at: now.toISOString() });
        result = { saved: true };
        break;
      }
      case 'related_question': {
        if (learn) throw new Error('Not available in learn mode. Continue with next_question.');
        const round = loadConfig().rounds.find((r) => r.id === s.round);
        if (!round?.followUps) throw new Error('This round has fixed questions. Continue with next_question.');
        if (s.plan.filter((p) => p.added).length >= MAX_ADDED) throw new Error(`Already added ${MAX_ADDED} questions from the candidate's answers. Continue with next_question.`);
        const q = relatedQuestion(String(args.topic ?? ''), s, round);
        if (!q) {
          result = { found: false, message: 'Nothing in the question bank on that. Ask your own follow up on it, or continue with next_question.' };
          break;
        }
        // It takes the place of the last planned question still waiting (never the closing one), so the
        // interview keeps its length, and goes in now so the numbering stays in order.
        const waiting = s.plan.map((p, i) => ({ p, i })).filter(({ p }) => !p.asked && !CLOSER.test(p.id));
        if (waiting.length) s.plan.splice(waiting[waiting.length - 1].i, 1);
        const at = s.plan.findIndex((p) => !p.asked);
        const item = { id: q.id, question: q.question, asked: true, added: true };
        if (at < 0) s.plan.push(item);
        else s.plan.splice(at, 0, item);
        result = { found: true, number: s.plan.indexOf(item) + 1, of: s.plan.length, question_id: q.id, question: q.question, note: 'Ask this now as your next main question, linked to what the candidate just said.' };
        break;
      }
      case 'end_interview': {
        s.endReason = String(args.reason ?? '').slice(0, 200);
        result = { ok: true, message: 'The page will end the call after your last sentence.' };
        break;
      }
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  } catch (err) {
    error = (err as Error).message;
    result = { error };
  }
  const call: ToolCall = { at: now.toISOString(), name, args, result, ms: Date.now() - started, ...(error ? { error } : {}), ...(t !== undefined && Number.isFinite(t) ? { t: Math.round(t * 10) / 10 } : {}) };
  s.toolCalls.push(call);
  saveSession(s);
  return call;
}

// ---------- Connection log (from the page) ----------

const MAX_DEBUG = 600;

/** Appends the page's Gemini Live events to the session and prints them to the server log. */
export function appendLog(id: string, entries: unknown) {
  const s = loadSession(id);
  if (!Array.isArray(entries)) throw new HttpError(400, 'entries must be a list');
  const clean = entries.slice(0, 200).flatMap((e: any) => {
    const event = String(e?.event ?? '').slice(0, 80);
    const t = Number(e?.t);
    if (!event || !Number.isFinite(t)) return [];
    const detail = e?.detail === undefined ? undefined : String(e.detail).slice(0, 500);
    return [{ t: Math.round(t * 10) / 10, event, ...(detail ? { detail } : {}) }];
  });
  if (process.env.LOG_LIVE_EVENTS === '1') for (const e of clean) console.log(`[live] ${id} +${e.t}s ${e.event}${e.detail ? ` ${e.detail}` : ''}`);
  s.debug = [...(s.debug ?? []), ...clean].slice(-MAX_DEBUG);
  saveSession(s);
  return { saved: clean.length };
}

// ---------- End: transcript and delivery metrics ----------

const FILLERS: [string, RegExp][] = [
  ['um / uh', /\b(um+|uh+|erm|hmm+)\b/g],
  ['basically', /\bbasically\b/g],
  ['actually', /\bactually\b/g],
  ['like', /\blike\b(?! (a|an|the|this|that|to)\b)/g],
  ['you know', /\byou know\b/g],
  ['I mean', /\bi mean\b/g],
  ['kind of / sort of', /\b(kind|sort) of\b/g],
  ['so yeah', /\bso yeah\b/g],
];

export function measure(transcript: TranscriptTurn[]): Metrics {
  const mine = transcript.filter((t) => t.who === 'candidate');
  const text = mine.map((t) => t.text).join(' ').toLowerCase();
  const wordCount = text.match(/[a-z0-9']+/g)?.length ?? 0;
  const seconds = mine.reduce((sum, t) => sum + Math.max(0, t.end - t.start), 0);
  const fillers: Record<string, number> = {};
  for (const [label, re] of FILLERS) {
    const n = text.match(re)?.length ?? 0;
    if (n) fillers[label] = n;
  }
  const fillerTotal = Object.values(fillers).reduce((a, b) => a + b, 0);
  const sentences = mine.flatMap((t) => t.text.split(/[.?!]+/)).map((s) => s.trim()).filter(Boolean);
  const minutes = seconds / 60;
  return {
    candidateWords: wordCount,
    candidateSeconds: Math.round(seconds),
    wordsPerMinute: minutes >= 0.25 ? Math.round(wordCount / minutes) : null,
    fillers,
    fillersPerMinute: minutes >= 0.25 ? Math.round((fillerTotal / minutes) * 10) / 10 : null,
    avgWordsPerSentence: sentences.length ? Math.round((wordCount / sentences.length) * 10) / 10 : null,
    longestAnswerSeconds: Math.round(Math.max(0, ...mine.map((t) => t.end - t.start))),
    sirMadam: text.match(/\b(sir|madam|ma'am)\b/g)?.length ?? 0,
    apologies: text.match(/\b(sorry|apologi[sz]e)\b/g)?.length ?? 0,
  };
}

function cleanTranscript(raw: unknown): TranscriptTurn[] {
  if (!Array.isArray(raw)) throw new HttpError(400, 'transcript must be a list');
  return raw.slice(0, 2000).flatMap((t: any) => {
    const who = t?.who === 'candidate' ? 'candidate' : t?.who === 'interviewer' ? 'interviewer' : null;
    const text = String(t?.text ?? '').replace(/<[^>\n]*>/g, '').trim().slice(0, 8000);
    const start = Number(t?.start);
    const end = Number(t?.end);
    if (!who || !text || !Number.isFinite(start) || !Number.isFinite(end)) return [];
    return [{ who, text, start: Math.max(0, start), end: Math.max(start, end) }];
  });
}

/** Saves the transcript once. Returns whether there is anything to grade. */
export function endSession(id: string, body: { transcript?: unknown; durationSeconds?: unknown; reason?: unknown }, now = new Date()) {
  const s = loadSession(id);
  if (s.status !== 'live') return { session: s, gradable: false, note: 'already ended' };
  s.transcript = cleanTranscript(body.transcript);
  s.durationSeconds = Math.max(0, Math.round(Number(body.durationSeconds) || 0));
  s.endedAt = now.toISOString();
  s.endReason = s.endReason || String(body.reason ?? 'ended on the page').slice(0, 200);
  s.metrics = measure(s.transcript);
  s.status = 'ended';
  saveSession(s);
  const gradable = s.transcript.some((t) => t.who === 'candidate');
  return { session: s, gradable, note: gradable ? 'saved' : 'no answers in the transcript, nothing to grade' };
}

// ---------- Review ----------

const txt = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const clampScore = (v: unknown) => Math.max(1, Math.min(10, Math.round(Number(v) || 0)));

/**
 * Saves a review (from Claude, or posted by hand), writes reports/<id>.md and, the first time only,
 * updates progress.json so weak answers come back sooner.
 */
export function saveReview(id: string, body: any, now = new Date(), reviewer = 'manual') {
  const s = loadSession(id);
  if (s.status === 'live') throw new HttpError(409, 'The session is still live');
  if (!Array.isArray(body?.answers) || !body.answers.length) throw new HttpError(400, 'answers must be a non-empty list');
  const answers: ReviewAnswer[] = body.answers.slice(0, 20).map((a: any) => ({
    question_id: txt(a?.question_id, 200),
    question: txt(a?.question, 500),
    score: clampScore(a?.score),
    technical: txt(a?.technical, 2000),
    structure: txt(a?.structure, 1000),
    delivery: txt(a?.delivery, 1000),
    rewrite: txt(a?.rewrite, 4000),
    fix: txt(a?.fix, 1000),
  }));
  const review: Review = {
    overall: clampScore(body.overall ?? answers.reduce((sum, a) => sum + a.score, 0) / answers.length),
    summary: txt(body.summary, 2000),
    answers,
    delivery: txt(body.delivery, 2000),
    next_focus: Array.isArray(body.next_focus) ? body.next_focus.slice(0, 5).map((f: unknown) => txt(f, 300)) : [],
    reviewedAt: now.toISOString(),
    reviewer,
  };
  const first = !s.review;
  s.review = review;
  s.status = 'reviewed';
  delete s.grading;
  delete s.reviewError;
  saveSession(s);
  // Progress counts each session once, so a re-posted review does not double the history.
  if (first) {
    const progress = readProgress();
    applyReview(progress, s, now);
    writeJson(paths.progress(), progress);
  }
  writeText(reportFile(id), reportMarkdown(s));
  return { session: s, report: path.relative(process.cwd(), reportFile(id)) };
}

/** Adds one reviewed session's scores to the spaced repetition record. */
function applyReview(progress: Progress, s: Session, at: Date): void {
  for (const a of s.review?.answers ?? []) {
    if (!s.plan.some((p) => p.id === a.question_id)) continue;
    const old = progress[a.question_id] ?? { asked: 0, scores: [], lastAsked: '', nextDue: '', failStreak: 0 };
    progress[a.question_id] = {
      asked: old.asked + 1,
      scores: [...old.scores, a.score].slice(-10),
      lastAsked: dayKey(at),
      nextDue: nextDue(a.score, a.score < 6 ? old.failStreak : 0, at),
      failStreak: a.score < 6 ? old.failStreak + 1 : 0,
    };
  }
}

/** Rebuilds progress.json from every reviewed session left on disk, oldest first. */
export function rebuildProgress(): Progress {
  const dir = paths.sessions();
  const reviewed = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson<Session | null>(path.join(dir, f), null))
    .filter((s): s is Session => !!s?.review?.reviewedAt && Array.isArray(s.review.answers))
    .sort((a, b) => a.review!.reviewedAt.localeCompare(b.review!.reviewedAt));
  const progress: Progress = {};
  for (const s of reviewed) applyReview(progress, s, new Date(s.review!.reviewedAt));
  writeJson(paths.progress(), progress);
  return progress;
}

/**
 * Deletes a session and its report, then rebuilds progress.json without it, so its questions count as
 * never asked (unless another session asked them). coach-notes.md and interviewer-notes.md are summaries
 * and stay as they are; edit them by hand if they mention it.
 */
export function deleteSession(id: string) {
  loadSession(id);
  fs.rmSync(sessionFile(id), { force: true });
  fs.rmSync(reportFile(id), { force: true });
  const progress = rebuildProgress();
  return { deleted: id, questionsTracked: Object.keys(progress).length };
}

export function reportMarkdown(s: Session): string {
  const config = loadConfig();
  const round = config.rounds.find((r) => r.id === s.round);
  const r = s.review!;
  const m = s.metrics;
  const out = [
    `# Mock interview: ${round?.label ?? s.round} (${config.personas[s.persona]?.label ?? s.persona})`,
    '',
    `${s.createdAt.slice(0, 10)} · ${Math.round((s.durationSeconds ?? 0) / 60)} min · overall **${r.overall}/10**${s.model ? ` · interviewer \`${s.model}\`` : ''}${s.prepPack ? ` · prep pack \`prep/${s.prepPack}\`` : ''}${r.reviewer ? ` · reviewed by \`${r.reviewer}\`` : ''}`,
    '',
    r.summary,
    '',
    '## Next time, focus on',
    ...r.next_focus.map((f) => `- ${f}`),
    '',
    '## Delivery',
    m ? `- ${m.wordsPerMinute ?? '?'} words per minute, ${m.fillersPerMinute ?? '?'} fillers per minute, ${m.avgWordsPerSentence ?? '?'} words per sentence, longest answer ${m.longestAnswerSeconds}s` : '',
    m && Object.keys(m.fillers).length ? `- Fillers: ${Object.entries(m.fillers).map(([k, v]) => `${k} ${v}`).join(', ')}` : '',
    m && (m.sirMadam || m.apologies) ? `- Sir/Madam ${m.sirMadam}, apologies ${m.apologies}` : '',
    r.delivery ? `- ${r.delivery}` : '',
    '',
    '## Answers',
  ];
  for (const a of r.answers) {
    out.push(
      '',
      `### ${a.score}/10 · ${a.question}`,
      a.question_id ? `\`questions/${a.question_id}.md\`` : '',
      '',
      `- **Content:** ${a.technical}`,
      `- **Structure:** ${a.structure}`,
      `- **Delivery:** ${a.delivery}`,
      `- **Fix next time:** ${a.fix}`,
      '',
      '**A stronger way to say it:**',
      '',
      ...a.rewrite.split('\n').map((l) => `> ${l}`),
    );
  }
  if (s.debriefs?.length) {
    out.push('', '## Spoken debriefs');
    for (const d of s.debriefs) {
      out.push('', `### ${d.at.slice(0, 16).replace('T', ' ')} UTC · ${Math.round(d.durationSeconds / 60)} min${d.voice ? ` · voice ${d.voice}` : ''}`, '');
      for (const t of d.transcript) out.push(`- **${t.who === 'interviewer' ? 'Coach' : 'You'}:** ${t.text.replace(/\s+/g, ' ').trim()}`);
    }
  }
  return out.filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n') + '\n';
}

// ---------- Spoken debrief ----------

/** Starts a spoken debrief of a reviewed session: a Gemini Live token and setup for the coach voice. */
export async function startDebrief(id: string, opts: { fetchImpl?: typeof fetch; voice?: unknown; turnTaking?: unknown } = {}) {
  const s = loadSession(id);
  if (!s.review) throw new HttpError(409, 'This session has no review yet');
  const voice = pickVoice(opts.voice, liveConfig().voice);
  const turnTaking = pickTurnTaking(opts.turnTaking);
  const token = await mintToken(20, opts.fetchImpl);
  return { wsUrl: liveConfig().wsUrl, token, voice, turnTaking, setup: liveSetup(liveModels().fast.model, debriefInstruction(s, loadConfig()), DEBRIEF_TOOLS, voice, turnTaking) };
}

/** Keeps the debrief's transcript with the session (the last 10), so practice attempts stay in the history. */
export function saveDebrief(id: string, body: { transcript?: unknown; durationSeconds?: unknown; voice?: unknown }, now = new Date()) {
  const s = loadSession(id);
  const transcript = cleanTranscript(body.transcript);
  if (!transcript.length) return { saved: false };
  const voice = typeof body.voice === 'string' && VOICES[body.voice] ? body.voice : undefined;
  s.debriefs = [...(s.debriefs ?? []), { at: now.toISOString(), durationSeconds: Math.max(0, Math.round(Number(body.durationSeconds) || 0)), ...(voice ? { voice } : {}), transcript }].slice(-10);
  saveSession(s);
  if (s.review) writeText(reportFile(id), reportMarkdown(s));
  return { saved: true, debriefs: s.debriefs.length };
}

// ---------- Cleanup ----------

const DAY = 86_400_000;

/**
 * Keeps history useful and small. Sessions with no answer (a failed start, a closed tab) are deleted after
 * a day. Sessions older than 30 days lose their connection log and tool call results (the questions,
 * transcript, metrics, review and debriefs stay). Reviewed sessions, reports and progress.json are never deleted.
 */
export function cleanupSessions(now = new Date()) {
  const dir = paths.sessions();
  const result = { deleted: [] as string[], compacted: [] as string[] };
  if (!fs.existsSync(dir)) return result;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const file = path.join(dir, f);
    const s = readJson<Session | null>(file, null);
    if (!s?.createdAt) continue;
    const age = now.getTime() - Date.parse(s.createdAt);
    const answered = s.transcript?.some((t) => t.who === 'candidate');
    if (!answered && !s.review && age > DAY) {
      fs.unlinkSync(file);
      result.deleted.push(s.id);
      continue;
    }
    if (age > 30 * DAY && (s.debug || s.toolCalls?.some((c) => c.result !== undefined))) {
      delete s.debug;
      s.toolCalls = (s.toolCalls ?? []).map(({ result: _drop, ...c }) => c as ToolCall);
      saveSession(s);
      result.compacted.push(s.id);
    }
  }
  return result;
}

/**
 * Grading runs inside the server process, so a `grading` flag from before a restart never clears. Each one
 * older than `olderThanMs` becomes a reviewError, so the page stops waiting and offers Try again.
 */
export function recoverGrading(olderThanMs = 0, now = new Date()): string[] {
  const dir = paths.sessions();
  if (!fs.existsSync(dir)) return [];
  const recovered: string[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const s = readJson<Session | null>(path.join(dir, f), null);
    if (!s?.grading || s.review) continue;
    if (now.getTime() - Date.parse(s.grading.startedAt) < olderThanMs) continue;
    delete s.grading;
    s.reviewError = 'Grading was interrupted (the server restarted). Press Try again.';
    saveSession(s);
    recovered.push(s.id);
  }
  return recovered;
}

// ---------- Question bank page ----------

/** Every question in the bank, its short answer and how it has gone so far. Private words are taken out. */
export function questionList(now = new Date()) {
  requireWorkspace();
  const config = loadConfig();
  const progress = readProgress();
  const today = dayKey(now);
  return loadBank().map((q) => {
    const p = progress[q.id];
    return {
      id: q.id,
      folder: q.folder,
      question: scrub(q.question, config),
      short: scrub(q.short, config),
      priority: q.priority ?? DEFAULT_PRIORITY,
      asked: p?.asked ?? 0,
      lastScore: p?.scores.at(-1) ?? null,
      lastAsked: p?.lastAsked ?? null,
      due: !!p && p.nextDue <= today,
    };
  });
}

/** One question's full notes (the file without its title), for the question bank page. */
export function questionNotes(id: string) {
  const q = bankEntry(id);
  if (!q) throw new HttpError(404, 'No such question');
  return { id, notes: lessonNotes(id) };
}

// ---------- Page options ----------

export function pageOptions(now = new Date(), grading = false) {
  const config = loadConfig();
  const progress = readProgress();
  const today = dayKey(now);
  const bank = fs.existsSync(paths.questions()) ? loadBank() : [];
  return {
    configured: liveConfig().configured,
    grading,
    workspaceReady: fs.existsSync(paths.questions()),
    questionCount: bank.length,
    models: Object.entries(liveModels()).map(([id, m]) => ({ id, ...m })),
    voices: Object.entries(VOICES).map(([id, style]) => ({ id, style })),
    defaultVoice: liveConfig().voice,
    defaultTutorVoice: liveConfig().tutorVoice,
    defaultMode: config.defaultMode,
    rounds: config.rounds.map(({ only: _only, mix, ...r }) => ({ ...r, questions: Object.values(mix).reduce((a, b) => a + b, 0) })),
    personas: Object.entries(config.personas).map(([id, p]) => ({ id, label: p.label })),
    topics: topicFolders(bank),
    prepPacks: listPrepPacks(),
    dueCount: Object.values(progress).filter((p) => p.nextDue <= today).length,
    maxPicked: MAX_PICKED,
    sessions: listSessions(),
  };
}
