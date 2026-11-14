import fs from 'node:fs';
import path from 'node:path';
import type { Mode, Persona, Round } from './types';

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

/**
 * Where each part lives. Every path can be moved with `paths` in config.json (relative to the workspace),
 * so an existing folder of notes can be used as it is, e.g. `"questions": "../qna"`.
 */
export interface PathSettings {
  questions?: string;
  /** A folder of .md files, or a list of files. */
  profile?: string | string[];
  prep?: string;
  sessions?: string;
  reports?: string;
  progress?: string;
  coachNotes?: string;
  interviewerNotes?: string;
}

const configFile = () => path.join(workspaceDir(), 'config.json');

/** config.json as written (no defaults), read on every call: it is small, and edits apply without a restart. */
function rawConfig(): Partial<ConfigFile> {
  return readJson<Partial<ConfigFile>>(configFile(), {});
}

function setting(key: keyof PathSettings, fallback: string): string {
  const v = rawConfig().paths?.[key];
  return path.resolve(workspaceDir(), typeof v === 'string' && v.trim() ? v : fallback);
}

export const paths = {
  config: configFile,
  questions: () => setting('questions', 'questions'),
  prep: () => setting('prep', 'prep'),
  sessions: () => setting('sessions', 'sessions'),
  reports: () => setting('reports', 'reports'),
  progress: () => setting('progress', 'progress.json'),
  coachNotes: () => setting('coachNotes', 'coach-notes.md'),
  interviewerNotes: () => setting('interviewerNotes', 'interviewer-notes.md'),
  /** The profile files: every .md in the profile folder, or the listed files. */
  profileFiles: (): string[] => {
    const v = rawConfig().paths?.profile;
    if (Array.isArray(v)) return v.filter((f) => typeof f === 'string').map((f) => path.resolve(workspaceDir(), f));
    const dir = path.resolve(workspaceDir(), typeof v === 'string' && v.trim() ? v : 'profile');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => path.join(dir, f));
  },
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

/** What config.json may hold (every field optional). */
interface ConfigFile {
  candidate: { name?: string; summary?: string };
  language: string;
  accent: string;
  secondLanguage: string;
  privateWords: string[];
  rounds: Round[];
  personas: Record<string, Persona>;
  paths: PathSettings;
  skip: { folders?: string[]; files?: string };
  reviewNotes: string[];
  defaultMode: Mode;
}

export interface Config {
  candidate: {
    /** Optional. The interviewer and the reviewer use it; leave it out to stay "the candidate". */
    name?: string;
    /** One line: role, years, stack, what you are practising for. */
    summary: string;
  };
  /** The language the interview stays in. */
  language: string;
  /** Optional: how the voice should sound, e.g. "Indian" (Gemini Live voices take their accent from the prompt). */
  accent?: string;
  /**
   * Optional, e.g. "Hindi": if you speak it, the tutor and the coach answer in a light mix (Hinglish: technical
   * terms in the main language, a few simple words in this one). The interview itself stays in `language`.
   */
  secondLanguage?: string;
  /**
   * Lines of your profile and prep packs that contain any of these words (any case) never reach the
   * interviewer or the reviewer: a side project, a client name, anything you don't want raised.
   */
  privateWords: string[];
  rounds: Round[];
  personas: Record<string, Persona>;
  /** Question folders to skip (besides `_`/`.` folders), and a regular expression for file names to skip. */
  skip: { folders: string[]; files: RegExp | null };
  /** Extra rules for the reviewer (Claude), e.g. facts it must not use in rewrites. */
  reviewNotes: string[];
  /** The mode the start form picks first: `interview` (default) or `learn` (the tutor teaches each answer first). */
  defaultMode: Mode;
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

/**
 * Rounds for the folders in examples/workspace/questions. Your config.json can replace the whole list. Every
 * round uses the quick model: on 2026-11-14 extended thinking never made a tool call (it says "a system error
 * occurred"; Google forum thread 185649). `npm run smoke:live thinking` checks whether it works again.
 */
export const DEFAULT_ROUNDS: Round[] = [
  { id: 'screening', label: 'Recruiter screen', about: 'Intro, motivation, remote work, notice period, pay.', mix: { screening: 5 }, minutes: 15, followUps: 2, persona: 'recruiter', model: 'fast', job: 'optional' },
  { id: 'behavioral', label: 'Behavioral (STAR)', about: 'Teamwork, conflict, ownership, incidents.', mix: { behavioral: 4 }, minutes: 20, followUps: 2, persona: 'manager', model: 'fast', job: 'optional' },
  { id: 'tech', label: 'Tech deep dive', about: 'Core concepts with follow ups.', mix: { nodejs: 2, typescript: 1, react: 2 }, minutes: 25, followUps: 2, persona: 'cto', model: 'fast', job: 'optional', topicPick: true },
  { id: 'system-design', label: 'System design (spoken)', about: 'One design end to end: requirements, API, data, scale, trade-offs.', mix: { 'system-design': 1 }, minutes: 35, followUps: 6, persona: 'bigtech', model: 'fast', job: 'none', only: 'design-' },
  { id: 'ai', label: 'AI engineering', about: 'AI tools at work, RAG, agents, evals.', mix: { ai: 4 }, minutes: 20, followUps: 2, persona: 'cto', model: 'fast', job: 'optional' },
  { id: 'real', label: 'Real interview', about: 'Built from a prep pack: the company, the role and its stack.', mix: { screening: 1, behavioral: 2, nodejs: 1, react: 1, 'system-design': 1 }, minutes: 30, followUps: 2, persona: 'cto', model: 'fast', job: 'required' },
  {
    id: 'communication',
    label: 'Communication practice',
    about: 'Clear spoken answers: headline first, short sentences, a real example, a clean ending.',
    mix: { screening: 2, behavioral: 2 },
    minutes: 15,
    followUps: 1,
    persona: 'manager',
    model: 'fast',
    job: 'none',
    instructions: 'If an answer rambles or has no example, use your one follow up to ask for the short version or a concrete example.',
    reviewFocus: 'This is a communication round: weigh structure and delivery (headline first, short sentences, no filler, a concrete example, a clean ending) more than technical depth.',
  },
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
  if ((r.instructions !== undefined && typeof r.instructions !== 'string') || (r.reviewFocus !== undefined && typeof r.reviewFocus !== 'string'))
    return `round ${r.id}: instructions and reviewFocus must be text`;
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
  const raw = rawConfig();
  const personas = { ...DEFAULT_PERSONAS, ...(raw.personas ?? {}) };
  const rounds = Array.isArray(raw.rounds) && raw.rounds.length ? raw.rounds : DEFAULT_ROUNDS;
  for (const r of rounds) {
    const problem = checkRound(r, personas);
    if (problem) throw new HttpError(500, `workspace/config.json: ${problem}`);
  }
  let files: RegExp | null = null;
  if (typeof raw.skip?.files === 'string' && raw.skip.files) {
    try {
      files = new RegExp(raw.skip.files, 'i');
    } catch {
      throw new HttpError(500, 'workspace/config.json: skip.files is not a valid regular expression');
    }
  }
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : []);
  return {
    candidate: {
      name: typeof raw.candidate?.name === 'string' && raw.candidate.name.trim() ? raw.candidate.name.trim() : undefined,
      summary: raw.candidate?.summary?.trim() || 'a software engineer practising for job interviews.',
    },
    language: raw.language?.trim() || 'English',
    accent: typeof raw.accent === 'string' && raw.accent.trim() ? raw.accent.trim() : undefined,
    secondLanguage: typeof raw.secondLanguage === 'string' && raw.secondLanguage.trim() ? raw.secondLanguage.trim() : undefined,
    privateWords: strings(raw.privateWords).map((w) => w.toLowerCase()),
    rounds,
    personas,
    skip: { folders: strings(raw.skip?.folders), files },
    reviewNotes: strings(raw.reviewNotes),
    defaultMode: raw.defaultMode === 'learn' ? 'learn' : 'interview',
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

/** Every profile file, scrubbed. */
export function profileTexts(): { file: string; text: string }[] {
  const config = loadConfig();
  return paths
    .profileFiles()
    .filter((f) => fs.existsSync(f))
    .map((f) => ({ file: path.basename(f), text: scrub(fs.readFileSync(f, 'utf8'), config) }));
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
