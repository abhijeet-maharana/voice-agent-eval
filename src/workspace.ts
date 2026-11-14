import fs from 'node:fs';
import path from 'node:path';
import type { Persona, Round } from './types';

/**
 * The workspace: your own interview material and everything the app writes. Nothing in it is committed
 * (it is in .gitignore). `npm run setup` copies examples/workspace here to start.
 *
 *   workspace/
 *     config.json            who you are, rounds, private words (all optional)
 *     questions/<folder>/*.md the question bank: "# Question" title + "## Short Answer" section
 *     profile/*.md           resume, about me: what the interviewer can look up about you
 *     prep/*.md              one file per real company interview (company, role, stack, likely questions)
 *     sessions/<id>.json     every call: plan, tool calls, transcript, metrics, review
 *     reports/<id>.md        the readable review of each call
 *     progress.json          spaced repetition: which questions come back and when
 *     coach-notes.md         your recurring gaps (written after each review, read by the next call)
 *     interviewer-notes.md   rules from the interviewer's own past mistakes (same)
 */

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const workspaceDir = () => path.resolve(process.env.WORKSPACE || 'workspace');

export const paths = {
  config: () => path.join(workspaceDir(), 'config.json'),
  questions: () => path.join(workspaceDir(), 'questions'),
  profile: () => path.join(workspaceDir(), 'profile'),
  prep: () => path.join(workspaceDir(), 'prep'),
  sessions: () => path.join(workspaceDir(), 'sessions'),
  reports: () => path.join(workspaceDir(), 'reports'),
  progress: () => path.join(workspaceDir(), 'progress.json'),
  coachNotes: () => path.join(workspaceDir(), 'coach-notes.md'),
  interviewerNotes: () => path.join(workspaceDir(), 'interviewer-notes.md'),
};

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Writes through a temp file and a rename, so a crash never leaves half a file. */
export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// ---------- Config ----------

export interface Config {
  candidate: {
    /** Optional. The interviewer and the reviewer use it; leave it out to stay "the candidate". */
    name?: string;
    /** One line: role, years, stack, what you are practising for. */
    summary: string;
  };
  /** The language the interview stays in. */
  language: string;
  /**
   * Lines of your profile and prep packs that contain any of these words (any case) never reach the
   * interviewer or the reviewer: a side project, a client name, anything you don't want raised.
   */
  privateWords: string[];
  rounds: Round[];
  personas: Record<string, Persona>;
}

export const DEFAULT_PERSONAS: Record<string, Persona> = {
  recruiter: {
    label: 'Recruiter',
    text: 'A friendly but efficient tech recruiter. Checks motivation, communication, remote readiness, notice period and pay expectations. Plain language, not deeply technical.',
  },
  manager: {
    label: 'Hiring manager',
    text: 'An engineering manager who cares about ownership, teamwork across time zones and honest reflection. Asks for concrete examples and what the candidate personally did.',
  },
  cto: {
    label: 'Startup CTO',
    text: 'A hands-on CTO at a funded startup. Direct and practical. Cares about shipping, trade-offs, production experience and owning outcomes. Pushes back on vague or textbook answers.',
  },
  bigtech: {
    label: 'Big tech panel',
    text: 'A senior engineer on a big tech interview panel. Structured and calm. Digs into requirements, scale numbers, data model, bottlenecks and trade-offs, one layer at a time.',
  },
  aiscreen: {
    label: 'AI screen bot',
    text: 'An automated AI video screening system. Neutral and scripted. Reads each question once, gives no reactions and no follow ups, and moves on with "Thank you. Next question."',
  },
};

/** Rounds for the folders in examples/workspace/questions. Your config.json can replace the whole list. */
export const DEFAULT_ROUNDS: Round[] = [
  { id: 'screening', label: 'Recruiter screen', about: 'Intro, motivation, remote work, notice period, pay.', mix: { screening: 5 }, minutes: 15, followUps: 2, persona: 'recruiter', model: 'fast', job: 'optional' },
  { id: 'behavioral', label: 'Behavioral (STAR)', about: 'Teamwork, conflict, ownership, incidents.', mix: { behavioral: 4 }, minutes: 20, followUps: 2, persona: 'manager', model: 'fast', job: 'optional' },
  { id: 'tech', label: 'Tech deep dive', about: 'Core concepts with follow ups.', mix: { nodejs: 2, typescript: 1, react: 2 }, minutes: 25, followUps: 2, persona: 'cto', model: 'fast', job: 'optional', topicPick: true },
  { id: 'system-design', label: 'System design (spoken)', about: 'One design end to end: requirements, API, data, scale, trade-offs.', mix: { 'system-design': 1 }, minutes: 35, followUps: 6, persona: 'bigtech', model: 'thinking', job: 'none', only: 'design-' },
  { id: 'ai', label: 'AI engineering', about: 'AI tools at work, RAG, agents, evals.', mix: { ai: 4 }, minutes: 20, followUps: 2, persona: 'cto', model: 'fast', job: 'optional' },
  { id: 'real', label: 'Real interview', about: 'Built from a prep pack: the company, the role and its stack.', mix: { screening: 1, behavioral: 2, nodejs: 1, react: 1, 'system-design': 1 }, minutes: 30, followUps: 2, persona: 'cto', model: 'fast', job: 'required' },
  { id: 'ai-screen', label: 'AI video screen', about: 'Like the one-way video screens: fixed questions, no follow ups, about 2 minutes each.', mix: { screening: 2, behavioral: 2, nodejs: 1, react: 1 }, minutes: 20, followUps: 0, persona: 'aiscreen', model: 'fast', job: 'optional' },
];

const ROUND_ID = /^[a-z][a-z0-9-]*$/;

function checkRound(r: Round, personas: Record<string, Persona>): string | null {
  if (!r || typeof r !== 'object') return 'a round must be an object';
  if (typeof r.id !== 'string' || !ROUND_ID.test(r.id)) return `round id "${r.id}" must be lowercase letters, digits and dashes`;
  if (!r.label || !r.mix || typeof r.mix !== 'object' || !Object.keys(r.mix).length) return `round ${r.id} needs a label and a mix`;
  if (!personas[r.persona]) return `round ${r.id}: unknown persona "${r.persona}"`;
  if (r.model !== 'fast' && r.model !== 'thinking') return `round ${r.id}: model must be "fast" or "thinking"`;
  if (!['required', 'optional', 'none'].includes(r.job)) return `round ${r.id}: job must be required, optional or none`;
  if (r.only) {
    try {
      new RegExp(r.only);
    } catch {
      return `round ${r.id}: "only" is not a valid regular expression`;
    }
  }
  return null;
}

/** Reads workspace/config.json on every call (it is small), so edits apply without a restart. */
export function loadConfig(): Config {
  const raw = readJson<Partial<Config>>(paths.config(), {});
  const personas = { ...DEFAULT_PERSONAS, ...(raw.personas ?? {}) };
  const rounds = Array.isArray(raw.rounds) && raw.rounds.length ? raw.rounds : DEFAULT_ROUNDS;
  for (const r of rounds) {
    const problem = checkRound(r, personas);
    if (problem) throw new HttpError(500, `workspace/config.json: ${problem}`);
  }
  return {
    candidate: {
      name: typeof raw.candidate?.name === 'string' && raw.candidate.name.trim() ? raw.candidate.name.trim() : undefined,
      summary: raw.candidate?.summary?.trim() || 'a software engineer practising for job interviews.',
    },
    language: raw.language?.trim() || 'English',
    privateWords: Array.isArray(raw.privateWords) ? raw.privateWords.filter((w) => typeof w === 'string' && w.trim()).map((w) => w.trim().toLowerCase()) : [],
    rounds,
    personas,
  };
}

/** The text without lines that contain a private word. */
export function scrub(text: string, config: Config = loadConfig()): string {
  if (!config.privateWords.length) return text;
  return text
    .split('\n')
    .filter((line) => {
      const l = line.toLowerCase();
      return !config.privateWords.some((w) => l.includes(w));
    })
    .join('\n');
}

export function requireWorkspace(): void {
  if (!fs.existsSync(paths.questions()))
    throw new HttpError(500, `No question bank at ${paths.questions()}. Run "npm run setup" to copy the examples, or set WORKSPACE.`);
}

// ---------- Profile and prep packs ----------

/** Every profile/*.md file, scrubbed. */
export function profileTexts(): { file: string; text: string }[] {
  const dir = paths.profile();
  if (!fs.existsSync(dir)) return [];
  const config = loadConfig();
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((file) => ({ file, text: scrub(fs.readFileSync(path.join(dir, file), 'utf8'), config) }));
}

export function listPrepPacks(): { file: string; title: string }[] {
  const dir = paths.prep();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse()
    .map((file) => ({ file, title: fs.readFileSync(path.join(dir, file), 'utf8').match(/^# (.+)$/m)?.[1]?.trim() ?? file }));
}

/** A prep pack's text, scrubbed. The name is checked so no path can leave prep/. */
export function readPrepPack(file: string): string {
  if (!/^[\w.-]+\.md$/.test(file) || file.startsWith('.')) throw new HttpError(400, 'bad prep pack name');
  const p = path.join(paths.prep(), file);
  if (!fs.existsSync(p)) throw new HttpError(404, `No prep pack ${file}`);
  return scrub(fs.readFileSync(p, 'utf8'));
}
