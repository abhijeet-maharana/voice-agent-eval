// Shapes shared by the server modules. The web app keeps its own copies of the fields it reads (web/src/api.ts).

/** `fast` answers in about a second, like a real call; `thinking` reasons before it speaks. */
export type LiveModelId = 'fast' | 'thinking';

/**
 * `interview`: a realistic call, no help. `learn`: a tutor shows and teaches each answer first, takes your
 * doubts, then asks you to explain it back, and only that explanation is scored.
 */
export type Mode = 'interview' | 'learn';

/**
 * How the voice knows you finished: `auto` replies after `pauseMs` of silence; `button` waits until you
 * press Done (Gemini's automatic voice activity detection is off, the page marks your turn).
 */
export interface TurnTaking {
  mode: 'auto' | 'button';
  pauseMs: number;
}

export interface Round {
  /** Lowercase letters, digits and dashes: it ends up in session ids and file names. */
  id: string;
  label: string;
  about: string;
  /** Where main questions come from: question folder => how many. */
  mix: Record<string, number>;
  minutes: number;
  /** Follow ups allowed after each main answer. 0 = a scripted screen (no follow ups, no reactions). */
  followUps: number;
  /** A persona id (see Persona). */
  persona: string;
  /** Default voice model; the page can pick the other one. */
  model: LiveModelId;
  /** Whether the round needs, can use, or ignores a company prep pack (prep/*.md). */
  job: 'required' | 'optional' | 'none';
  /** Only question files whose id matches this regular expression, e.g. "design-" for the system design round. */
  only?: string;
  /** The page lets you narrow the round to one question folder. */
  topicPick?: boolean;
  /** Extra instructions for the interviewer in this round, e.g. "Focus on CSS layout and accessibility." */
  instructions?: string;
  /** What the reviewer should weigh most in this round, e.g. "Delivery and structure matter more than depth." */
  reviewFocus?: string;
}

export interface Persona {
  label: string;
  /** How the interviewer behaves, in a sentence or three. Goes into the live prompt. */
  text: string;
}

export interface BankQuestion {
  /** `<folder>/<file without .md>`, e.g. `nodejs/010-explain-the-event-loop`. */
  id: string;
  folder: string;
  question: string;
  /** The file's "Short Answer" section (or its first paragraph): what a strong answer covers. */
  short: string;
}

export interface ProgressEntry {
  asked: number;
  scores: number[];
  lastAsked: string;
  nextDue: string;
  /** Answers in a row that scored under 6. */
  failStreak: number;
}
export type Progress = Record<string, ProgressEntry>;

export interface ToolCall {
  at: string;
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  ms: number;
  error?: string;
  /** Seconds since the session started, on the page's clock (the same clock as the transcript). */
  t?: number;
}

export interface TranscriptTurn {
  who: 'interviewer' | 'candidate';
  text: string;
  /** Seconds since the session started. */
  start: number;
  end: number;
}

export interface Metrics {
  candidateWords: number;
  candidateSeconds: number;
  wordsPerMinute: number | null;
  fillers: Record<string, number>;
  fillersPerMinute: number | null;
  avgWordsPerSentence: number | null;
  longestAnswerSeconds: number;
  sirMadam: number;
  apologies: number;
}

export interface ReviewAnswer {
  question_id: string;
  question: string;
  score: number;
  technical: string;
  structure: string;
  delivery: string;
  rewrite: string;
  fix: string;
}

export interface Review {
  overall: number;
  summary: string;
  answers: ReviewAnswer[];
  delivery: string;
  next_focus: string[];
  reviewedAt: string;
  /** Which model graded it (or "manual" for a review posted by hand). */
  reviewer?: string;
}

export interface Session {
  id: string;
  round: string;
  persona: string;
  topic?: string;
  prepPack?: string;
  /** Missing on older sessions: `interview`. */
  mode?: Mode;
  modelChoice?: LiveModelId;
  /** The model name sent to Gemini. */
  model?: string;
  createdAt: string;
  status: 'live' | 'ended' | 'reviewed';
  /** `added`: picked live by related_question from something the candidate said (it replaced a planned question). */
  /** `recalled`: learn mode, the candidate started explaining it back (start_recall). */
  plan: { id: string; question: string; asked: boolean; added?: boolean; recalled?: boolean }[];
  toolCalls: ToolCall[];
  notes: { question_id: string; rating: number; note: string; at: string }[];
  transcript: TranscriptTurn[];
  durationSeconds?: number;
  endedAt?: string;
  endReason?: string;
  metrics?: Metrics;
  review?: Review;
  /** Set while Claude grades the call; cleared when the review is saved or grading fails. */
  grading?: { startedAt: string };
  /** Why the last grading attempt failed (shown on the page, with a retry button). */
  reviewError?: string;
  /** The page's connection log (Gemini Live events), for debugging; also printed to the server log. */
  debug?: { t: number; event: string; detail?: string }[];
  /** Spoken debriefs of the review (the coach voice), newest last. */
  debriefs?: { at: string; durationSeconds: number; voice?: string; transcript: TranscriptTurn[] }[];
  /** The interviewer's voice (a VOICES name). */
  voice?: string;
  turnTaking?: TurnTaking;
  /** The candidate picked the questions on the question bank page (not spaced repetition). */
  picked?: boolean;
}
