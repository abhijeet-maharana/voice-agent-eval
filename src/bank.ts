import fs from 'node:fs';
import path from 'node:path';
import type { BankQuestion, Progress, Round, Session } from './types';
import { loadConfig, paths, readJson } from './workspace';

/**
 * The question bank (workspace/questions/<folder>/*.md) and spaced repetition (workspace/progress.json).
 *
 * A question file is markdown: the `# Title` is the question, and a `## Short Answer` section (or the first
 * paragraph) says what a strong answer covers. The interviewer reads that part to judge answers and pick
 * follow ups; the reviewer reads the whole file. Folders and files starting with `_` or `.`, and READMEs,
 * are notes, not questions.
 */

export function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9+#.]+/g)?.filter((w) => w.length > 2) ?? [];
}

function section(text: string, heading: RegExp): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return '';
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3} /.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

export function parseQuestion(folder: string, file: string, text: string): BankQuestion | null {
  const title = text.match(/^# (.+)$/m)?.[1]?.trim();
  if (!title) return null;
  let short = section(text, /^##+ .*short answer/i);
  if (!short) short = text.split('\n\n').find((p) => p.trim() && !p.trimStart().startsWith('#'))?.trim() ?? '';
  const question = title
    .replace(/\*\*/g, '')
    .replace(/^(Question|Q)\s*\d*\s*[:.]\s*/i, '')
    .replace(/^["“](.+?)["”]/, '$1')
    // Notes for the reader, not words for the interviewer: "Tell me about yourself (the 75 second pitch)".
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
  return { id: `${folder}/${file.replace(/\.md$/, '')}`, folder, question, short: short.slice(0, 1500) };
}

const isNote = (name: string) => /^[_.]/.test(name) || /^readme/i.test(name);

export function loadBank(): BankQuestion[] {
  const dir = paths.questions();
  const { skip } = loadConfig();
  const out: BankQuestion[] = [];
  for (const folder of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    if (isNote(folder) || skip.folders.includes(folder) || !/^[\w.-]+$/.test(folder) || !fs.statSync(path.join(dir, folder)).isDirectory()) continue;
    for (const file of fs.readdirSync(path.join(dir, folder)).sort()) {
      if (!file.endsWith('.md') || isNote(file) || skip.files?.test(file) || !/^[\w.-]+$/.test(file)) continue;
      const q = parseQuestion(folder, file, fs.readFileSync(path.join(dir, folder, file), 'utf8'));
      if (q) out.push(q);
    }
  }
  return out;
}

/** The question folders that hold at least one question. */
export const topicFolders = (bank = loadBank()) => [...new Set(bank.map((q) => q.folder))];

/** A question file's path from its id, or undefined when the id is malformed or the file is gone. */
export function questionFile(id: string): string | undefined {
  const [folder, file, extra] = id.split('/');
  if (extra !== undefined || !folder || !file || !/^[\w.-]+$/.test(folder) || !/^[\w.-]+$/.test(file) || isNote(folder) || isNote(file)) return undefined;
  const p = path.join(paths.questions(), folder, `${file}.md`);
  return fs.existsSync(p) ? p : undefined;
}

export function bankEntry(id: string): BankQuestion | undefined {
  const p = questionFile(id);
  if (!p) return undefined;
  const [folder, file] = id.split('/');
  return parseQuestion(folder, `${file}.md`, fs.readFileSync(p, 'utf8')) ?? undefined;
}

// ---------- Spaced repetition ----------

export const readProgress = (): Progress => readJson<Progress>(paths.progress(), {});

export const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** Under 6 comes back after 1, 3, then 7 days; 6 or 7 after a week; 8+ after three weeks. */
export function nextDue(score: number, failStreak: number, now = new Date()): string {
  if (score < 6) return dayKey(addDays(now, [1, 3, 7][Math.min(failStreak, 2)]));
  return dayKey(addDays(now, score < 8 ? 7 : 21));
}

/** A real call opens with the pitch and ends with the candidate's own questions. */
export const OPENER = /tell-me-about-yourself|elevator-pitch|introduce-yourself/;
export const CLOSER = /questions-to-ask|reverse-questions|questions-for-us/;

function shuffle<T>(items: T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Main questions for a round: per folder, questions due for repeat first (oldest due first), then never
 * asked, then the ones asked longest ago. `topic` narrows a round with `topicPick` to one folder.
 */
export function pickQuestions(round: Round, bank: BankQuestion[], progress: Progress, opts: { topic?: string; now?: Date; rand?: () => number } = {}): BankQuestion[] {
  const today = dayKey(opts.now ?? new Date());
  const rand = opts.rand ?? Math.random;
  const only = round.only ? new RegExp(round.only) : null;
  const mix: Record<string, number> =
    opts.topic && round.topicPick ? { [opts.topic]: Object.values(round.mix).reduce((a, b) => a + b, 0) } : round.mix;
  const picked: BankQuestion[] = [];
  for (const [folder, count] of Object.entries(mix)) {
    const pool = bank.filter((q) => q.folder === folder && (!only || only.test(q.id)));
    const due = pool.filter((q) => progress[q.id] && progress[q.id].nextDue <= today).sort((a, b) => progress[a.id].nextDue.localeCompare(progress[b.id].nextDue));
    const fresh = shuffle(pool.filter((q) => !progress[q.id]), rand);
    const rest = pool.filter((q) => progress[q.id] && progress[q.id].nextDue > today).sort((a, b) => progress[a.id].lastAsked.localeCompare(progress[b.id].lastAsked));
    picked.push(...[...due, ...fresh, ...rest].slice(0, count));
  }
  const rank = (q: BankQuestion) => (OPENER.test(q.id) ? 0 : CLOSER.test(q.id) ? 2 : 1);
  return picked.map((q, i) => ({ q, i })).sort((a, b) => rank(a.q) - rank(b.q) || a.i - b.i).map((x) => x.q);
}

/** Questions the interviewer may add live from the candidate's answers (related_question). */
export const MAX_ADDED = 2;

/**
 * The bank question closest to a topic the candidate raised: most shared words with its title (counted
 * twice) and short answer, from the round's folders first, never one already in the plan, never one asked
 * in the last week.
 */
export function relatedQuestion(topic: string, s: Pick<Session, 'plan'>, round: Round, bank = loadBank(), progress = readProgress(), now = new Date()): BankQuestion | null {
  const terms = new Set(words(topic));
  if (!terms.size) return null;
  const weekAgo = dayKey(addDays(now, -7));
  const inPlan = new Set(s.plan.map((p) => p.id));
  const folders = new Set(Object.keys(round.mix));
  let best: { q: BankQuestion; score: number } | null = null;
  for (const q of bank) {
    if (inPlan.has(q.id) || (progress[q.id] && progress[q.id].lastAsked > weekAgo) || OPENER.test(q.id) || CLOSER.test(q.id)) continue;
    const score = 2 * words(q.question).filter((w) => terms.has(w)).length + words(q.short).filter((w) => terms.has(w)).length + (folders.has(q.folder) ? 0.5 : 0);
    if (score >= 2 && (!best || score > best.score)) best = { q, score };
  }
  return best?.q ?? null;
}
