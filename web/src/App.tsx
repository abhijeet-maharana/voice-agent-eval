import { Component, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { ApiError, beacon, del, get, post } from './api';
import { LiveInterview, type FunctionCall, type LiveState, type Turn as TurnState } from './live';
import { Btn, Card, ConfirmButton, Empty, Section, SpeakerIcon, Stat, Tag, mmss, scoreTone, when } from './ui';

// The whole app: pick a round (Setup), talk to the interviewer (Live), read and hear the review (Done).
// Every tool the interviewer calls is shown with its arguments and result.

interface LogEntry {
  t: number;
  event: string;
  detail?: string;
}

interface RoundInfo {
  id: string;
  label: string;
  about: string;
  minutes: number;
  followUps: number;
  persona: string;
  model: string;
  job: 'required' | 'optional' | 'none';
  topicPick?: boolean;
  questions: number;
}

interface SessionSummary {
  id: string;
  round: string;
  model?: string;
  createdAt: string;
  status: 'live' | 'ended' | 'reviewed';
  durationSeconds?: number;
  overall?: number;
  debriefs?: number;
  mode?: 'interview' | 'learn';
  picked?: boolean;
  grading?: boolean;
  gradingFailed?: boolean;
}

interface Options {
  configured: boolean;
  grading: boolean;
  workspaceReady: boolean;
  questionCount: number;
  models: { id: string; label: string; model: string }[];
  voices: { id: string; style: string }[];
  defaultVoice: string;
  defaultTutorVoice: string;
  defaultMode: 'interview' | 'learn';
  rounds: RoundInfo[];
  personas: { id: string; label: string }[];
  topics: string[];
  prepPacks: { file: string; title: string }[];
  dueCount: number;
  maxPicked: number;
  sessions: SessionSummary[];
}

interface ToolCallRecord {
  at: string;
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  ms: number;
  error?: string;
}

interface Turn {
  who: 'interviewer' | 'candidate';
  text: string;
  start: number;
  end: number;
}

interface Review {
  overall: number;
  summary: string;
  delivery: string;
  next_focus: string[];
  reviewer?: string;
  answers: { question_id: string; question: string; score: number; technical: string; structure: string; delivery: string; rewrite: string; fix: string }[];
}

interface Session {
  id: string;
  round: string;
  persona: string;
  mode?: 'interview' | 'learn';
  turnTaking?: TurnTaking;
  model?: string;
  createdAt: string;
  status: 'live' | 'ended' | 'reviewed';
  plan: { id: string; question: string; asked: boolean; added?: boolean }[];
  toolCalls: ToolCallRecord[];
  notes: { question_id: string; rating: number; note: string }[];
  transcript: Turn[];
  durationSeconds?: number;
  debug?: LogEntry[];
  debriefs?: { at: string; durationSeconds: number; voice?: string; transcript: Turn[] }[];
  metrics?: {
    wordsPerMinute: number | null;
    fillersPerMinute: number | null;
    avgWordsPerSentence: number | null;
    longestAnswerSeconds: number;
    fillers: Record<string, number>;
    sirMadam: number;
    apologies: number;
  };
  review?: Review;
  grading?: { startedAt: string };
  reviewError?: string;
}

/** A tool call on screen: running until the server answers. */
interface ShownCall {
  key: string;
  name: string;
  args: Record<string, unknown>;
  at: number;
  result?: unknown;
  ms?: number;
  error?: string;
}

type LiveStart = { wsUrl: string; token: string; setup: { setup: Record<string, unknown> }; kickoff?: string };

/** How the voice knows you finished: after a pause, or when you press Done. Remembered per browser. */
type TurnTaking = { mode: 'auto' | 'button'; pauseMs: number };
const TURN_CHOICES: { key: string; label: string; short: string; value: TurnTaking }[] = [
  { key: 'auto-1500', label: 'Auto: replies after a 1.5 s pause (quick)', short: 'replies after 1.5 s', value: { mode: 'auto', pauseMs: 1500 } },
  { key: 'auto-3000', label: 'Auto: replies after a 3 s pause', short: 'replies after 3 s', value: { mode: 'auto', pauseMs: 3000 } },
  { key: 'auto-6000', label: 'Auto: replies after a 6 s pause (lots of thinking time)', short: 'replies after 6 s', value: { mode: 'auto', pauseMs: 6000 } },
  { key: 'button', label: 'Button: waits until you press Done (or Space)', short: 'waits for Done', value: { mode: 'button', pauseMs: 3000 } },
];
/** Button by default: a pause to think never ends your answer. */
const DEFAULT_TURN = 'button';
const turnChoice = (key: string) => TURN_CHOICES.find((c) => c.key === key) ?? TURN_CHOICES.find((c) => c.key === DEFAULT_TURN)!;

/** Space = Done / interrupt (button mode), P = pause or resume. Ignored while typing in a field. */
function useCallKeys(onSpace: () => void, onP: () => void) {
  const handlers = useRef({ onSpace, onP });
  handlers.current = { onSpace, onP };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        handlers.current.onSpace();
      } else if (e.key === 'p' || e.key === 'P') handlers.current.onP();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Done / Interrupt (button mode) and Pause, shared by the interview and the spoken review. */
function CallControls({ li, turnMode, turn, state, paused, onPause }: { li: LiveInterview | null; turnMode: 'auto' | 'button'; turn: TurnState; state: LiveState; paused: boolean; onPause: () => void }) {
  useCallKeys(
    () => {
      if (turnMode !== 'button' || paused) return;
      if (turn === 'yours') li?.done();
      else if (state === 'speaking') li?.interrupt();
    },
    onPause,
  );
  return (
    <>
      {turnMode === 'button' &&
        (turn === 'yours' ? (
          <button type="button" className="btn green big" onClick={() => li?.done()} disabled={paused}>
            Done answering <kbd>Space</kbd>
          </button>
        ) : state === 'speaking' ? (
          <button type="button" className="btn ghost" onClick={() => li?.interrupt()} disabled={paused}>
            Interrupt <kbd>Space</kbd>
          </button>
        ) : (
          <button type="button" className="btn ghost" disabled>
            {turn === 'waiting' ? 'Thinking…' : 'Wait for the question…'}
          </button>
        ))}
      <button type="button" className="btn ghost" onClick={onPause}>
        {paused ? 'Resume' : 'Pause'} <kbd>P</kbd>
      </button>
    </>
  );
}

/** Covers the screen while paused, so whoever walked in sees nothing. Everything behind it is inert (no focus, no clicks). */
function PausedCover({ onResume }: { onResume: () => void }) {
  useEffect(() => {
    const behind = [...(document.querySelector('main')?.children ?? [])].filter((el): el is HTMLElement => el instanceof HTMLElement && !el.classList.contains('paused-cover'));
    behind.forEach((el) => (el.inert = true));
    return () => behind.forEach((el) => (el.inert = false));
  }, []);
  return (
    <div className="paused-cover" role="dialog" aria-modal="true" aria-label="Paused">
      <div>
        <h2>Paused</h2>
        <p className="dim">Your mic is off and the voice is frozen. It carries on from the same word.</p>
        <button type="button" className="btn green big" onClick={onResume} autoFocus>
          Resume <kbd>P</kbd>
        </button>
      </div>
    </div>
  );
}
type StartResult = { session: Session; live: LiveStart };

/** An error in plain words, with what to do; the raw message stays underneath for debugging. */
function friendlyError(msg: string): { text: string; detail?: string } {
  if (/Gemini token request failed \((400|401|403)\)/.test(msg)) return { text: 'Gemini refused the API key. Check GEMINI_API_KEY in .env, then restart the server.', detail: msg };
  if (/Gemini token request failed/.test(msg)) return { text: 'Could not open a Gemini session just now. Try again in a minute.', detail: msg };
  if (/Permission denied|NotAllowedError|not allowed by the user/i.test(msg)) return { text: 'The browser blocked the microphone. Allow it from the icon in the address bar, then start again.', detail: msg };
  if (/Claude API error (429|5\d\d)|overloaded/i.test(msg)) return { text: 'Claude is busy right now. Nothing is lost: try again in a few minutes.', detail: msg };
  return { text: msg };
}

function ErrorBar({ message, children }: { message: string; children?: ReactNode }) {
  const e = friendlyError(message);
  return (
    <div className="nowbar bad" role="alert">
      <Tag tone="bad">Error</Tag> <span>{e.text}</span>
      {e.detail && <span className="dim small">{e.detail}</span>}
      {children}
    </div>
  );
}

/** Remembered per browser (a convenience only: storage can be blocked, so every access is guarded). */
const remembered = (key: string) => {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private window or blocked storage */
  }
};

const STATE_LABEL: Record<LiveState, string> = { connecting: 'Connecting', listening: 'Listening', speaking: 'Interviewer speaking', reconnecting: 'Reconnecting', closed: 'Ended' };
const folderLabel = (f: string) => f.replace(/^\d+-/, '').replace(/-/g, ' ');

/**
 * Just enough markdown for question notes: headings, bullets, numbered lines, code blocks, **bold** and
 * `code`. Everything is rendered as text nodes (no HTML from the file reaches the page).
 */
function inline(text: string, key: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
      <b key={`${key}-${i}`}>{part.slice(2, -2)}</b>
    ) : part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
      <code key={`${key}-${i}`}>{part.slice(1, -1)}</code>
    ) : (
      part
    ),
  );
}

function Md({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const code: string[] = [];
      while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i]);
      out.push(<pre key={i} className="md-code">{code.join('\n')}</pre>);
    } else if (/^#{1,6} /.test(line)) out.push(<h4 key={i}>{inline(line.replace(/^#+ /, ''), String(i))}</h4>);
    else if (/^\s*([-*]|\d+\.) /.test(line)) out.push(<div key={i} className="md-li">{inline(line.trim(), String(i))}</div>);
    else if (line.trim()) out.push(<p key={i}>{inline(line, String(i))}</p>);
  }
  return <div className="md">{out}</div>;
}

/** Handed from the Start click to the live view: audio is set up inside the click (browsers allow it only then). */
let pendingLive: { li: LiveInterview; started: StartResult } | null = null;
/** Handed from the Listen click to the debrief view. */
let pendingDebrief: { li: LiveInterview; live: LiveStart } | null = null;

/** A handed over call, held by the view that runs it. */
type Handoff<T> = { value: T; stopTimer?: ReturnType<typeof setTimeout> };

/**
 * Takes the handed over call into `ref` on the first run of a view's effect; returns true on that first run.
 * React's StrictMode (npm run dev:web) runs an effect, its cleanup, then the effect again on the same mount,
 * keeping refs. So the cleanup only schedules the hang up (`stopTimer`), and a second run cancels it and keeps
 * the same call instead of finding the handoff empty.
 */
function takeHandoff<T>(ref: { current: Handoff<T> | null }, take: () => T | null): boolean {
  if (ref.current) {
    clearTimeout(ref.current.stopTimer);
    ref.current.stopTimer = undefined;
    return false;
  }
  const value = take();
  if (value) ref.current = { value };
  return !!value;
}

export default function App() {
  const [opts, setOpts] = useState<Options | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unlock, setUnlock] = useState<string | null>(null);
  const [view, setViewState] = useState<{ kind: 'setup' } | { kind: 'bank' } | { kind: 'live'; session: Session } | { kind: 'done'; id: string }>({ kind: 'setup' });
  // Opening a past session or going back to the form starts clean. A call that ends keeps its error on
  // the review screen, so you can still see why it stopped.
  const setView = (v: typeof view) => {
    if (v.kind === 'setup' || view.kind === 'setup') {
      setError(null);
      setUnlock(null);
    }
    setViewState(v);
  };

  const load = () => get<Options>('api/options').then(setOpts, (e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  const micOk = window.isSecureContext && !!navigator.mediaDevices;

  /** Start (the form) or Interview / Learn (the question bank): audio is set up inside the click. */
  const startCall = async (input: Record<string, unknown>) => {
    setError(null);
    const li = new LiveInterview();
    try {
      await li.prepareAudio();
      const r = await post<StartResult>('api/sessions', input);
      pendingLive = { li, started: r };
      setView({ kind: 'live', session: r.session });
    } catch (e) {
      li.stop();
      setError((e as Error).message);
      setUnlock(e instanceof ApiError ? (e.unlock ?? null) : null);
      window.scrollTo(0, 0);
    }
  };

  return (
    <main className="main">
      <header className="page-head">
        <div>
          <h1>Voice Interviewer</h1>
          {view.kind === 'setup' && <p className="sub">Practise interviews out loud with a live voice built from your own questions, profile and prep packs. Claude scores every answer afterwards.</p>}
        </div>
      </header>
      {!opts ? (
        <div className="loading">{error ? `Could not reach the server: ${error}` : 'Loading…'}</div>
      ) : (
        <>
          {error && <ErrorBar message={error}>{unlock && <a href={unlock}>Sign in</a>}</ErrorBar>}
          {!opts.workspaceReady && (
            <div className="nowbar">
              <Tag tone="warn">No questions</Tag> There is no workspace yet. Run <code>npm run setup</code> to copy the examples, then reload.
            </div>
          )}
          {!opts.configured && (
            <div className="nowbar">
              <Tag tone="warn">Off</Tag> <b>GEMINI_API_KEY</b> is not set in <code>.env</code>, so the live interviewer can't start. Add it and restart the server.
            </div>
          )}
          {!micOk && view.kind === 'setup' && (
            <div className="nowbar">
              <Tag tone="warn">No mic</Tag> Browsers allow the microphone only on <b>localhost</b> or HTTPS. Open this page on http://localhost.
            </div>
          )}
          {view.kind === 'setup' && (
            <Setup opts={opts} micOk={micOk} onStart={startCall} onBrowse={() => setView({ kind: 'bank' })} onOpen={(id) => setView({ kind: 'done', id })} onDeleted={() => void load()} />
          )}
          {view.kind === 'bank' && <QuestionBank opts={opts} micOk={micOk} onStart={startCall} onBack={() => setView({ kind: 'setup' })} />}
          {view.kind === 'live' && (
            <LiveGuard sessionId={view.session.id}>
              <Live key={view.session.id} session={view.session} onError={(e) => setError((e as Error).message)} onDone={(id) => setView({ kind: 'done', id })} />
            </LiveGuard>
          )}
          {view.kind === 'done' && (
            <Done
              id={view.id}
              opts={opts}
              onBack={() => {
                setView({ kind: 'setup' });
                void load();
              }}
            />
          )}
        </>
      )}
    </main>
  );
}

function VoiceSelect({ label, value, onChange, opts, dflt = opts.defaultVoice }: { label: string; value: string; onChange: (v: string) => void; opts: Options; dflt?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">
          Default ({dflt}, {opts.voices.find((v) => v.id === dflt)?.style.toLowerCase()})
        </option>
        {opts.voices.map((v) => (
          <option key={v.id} value={v.id}>
            {v.id}: {v.style.toLowerCase()}
          </option>
        ))}
      </select>
    </label>
  );
}

const MODES: { id: 'interview' | 'learn'; label: string; sub: string }[] = [
  { id: 'interview', label: 'Interview', sub: 'A real call, no help' },
  { id: 'learn', label: 'Learn', sub: 'See the answer, ask doubts, explain it back' },
];

/** A choice remembered per browser, used only while it is still one of the options. */
function useRemembered<T extends string>(key: string, valid: (v: string) => boolean, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const v = remembered(key);
    return (valid(v) ? v : fallback) as T;
  });
  return [
    value,
    (v: T) => {
      setValue(v);
      remember(key, v);
    },
  ];
}

function Setup({ opts, micOk, onStart, onBrowse, onOpen, onDeleted }: { opts: Options; micOk: boolean; onStart: (input: Record<string, unknown>) => Promise<void>; onBrowse: () => void; onOpen: (id: string) => void; onDeleted: () => void }) {
  const [round, setRound] = useRemembered<string>('vi.round', (v) => opts.rounds.some((x) => x.id === v), opts.rounds[0]?.id ?? '');
  const [mode, setMode] = useRemembered<'interview' | 'learn'>('vi.mode', (v) => v === 'interview' || v === 'learn', opts.defaultMode);
  const [turnKey, setTurnKey] = useRemembered<string>('vi.turn', (v) => TURN_CHOICES.some((c) => c.key === v), DEFAULT_TURN);
  const [voice, setVoice] = useRemembered<string>('vi.voice', (v) => opts.voices.some((x) => x.id === v), '');
  const r = opts.rounds.find((x) => x.id === round) ?? opts.rounds[0];
  const [persona, setPersona] = useState('');
  const [topic, setTopic] = useState('');
  const [prepPack, setPrepPack] = useState('');
  const [model, setModel] = useState('');
  const needsPack = r?.job === 'required';
  const learn = mode === 'learn';

  // Why Start is off, said next to it instead of a silently grey button.
  const blocked = !opts.configured
    ? 'Set GEMINI_API_KEY in .env and restart the server to start a call.'
    : !opts.workspaceReady
      ? 'Add a question bank first (see the note above).'
      : !micOk
        ? 'The microphone needs localhost or HTTPS.'
        : !r
          ? 'No rounds are set up in config.json.'
          : needsPack && !prepPack
            ? 'Pick a company prep pack to start this round.'
            : null;
  const settingsSummary = [
    opts.personas.find((p) => p.id === (persona || r?.persona))?.label,
    `voice ${voice || (learn ? opts.defaultTutorVoice : opts.defaultVoice)}`,
    turnChoice(turnKey).short,
    (model || r?.model) === 'thinking' ? 'extended thinking' : 'quick replies',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <Section
        title="Start a round"
        sub={`${opts.questionCount} questions in your bank · ${opts.dueCount ? `${opts.dueCount} due for repeat` : 'no repeats due'}`}
        actions={
          opts.workspaceReady && (
            <button type="button" className="btn ghost" onClick={onBrowse}>
              Browse questions and answers
            </button>
          )
        }
      >
        <Card>
          <fieldset className="seg">
            <legend className="field-label">Mode</legend>
            <div className="seg-opts">
              {MODES.map((m) => (
                <label key={m.id} className={`seg-opt ${mode === m.id ? 'on' : ''}`}>
                  <input type="radio" name="mode" value={m.id} checked={mode === m.id} onChange={() => setMode(m.id)} />
                  <b>{m.label}</b>
                  <span>{m.sub}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="form-grid">
            <label className="field">
              <span className="field-label">Round</span>
              <select className="input" value={round} onChange={(e) => setRound(e.target.value)}>
                {opts.rounds.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label} · {x.minutes} min
                  </option>
                ))}
              </select>
            </label>
            {r?.topicPick && (
              <label className="field">
                <span className="field-label">Topic</span>
                <select className="input" value={topic} onChange={(e) => setTopic(e.target.value)}>
                  <option value="">Mixed</option>
                  {opts.topics.map((t) => (
                    <option key={t} value={t}>
                      {folderLabel(t)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {r?.job !== 'none' && (
              <label className="field">
                <span className="field-label">Company prep pack {needsPack ? '(required)' : '(optional)'}</span>
                <select className="input" value={prepPack} onChange={(e) => setPrepPack(e.target.value)}>
                  <option value="">{needsPack ? 'Pick one' : 'None: general practice'}</option>
                  {opts.prepPacks.map((p) => (
                    <option key={p.file} value={p.file}>
                      {p.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <p className="hint">
            {r?.about} {r?.questions} {learn ? 'question' : 'main question'}
            {r?.questions === 1 ? '' : 's'}
            {learn
              ? '. For each one the tutor shows and teaches the answer, takes your doubts, then asks you to explain it back; only your explanation is scored.'
              : `, ${r?.followUps ? `up to ${r.followUps} follow ups each` : 'no follow ups'}.`}{' '}
            Wear headphones so its voice doesn't leak into your mic.
          </p>
          <details className="settings">
            <summary>
              Call settings <span className="dim">{settingsSummary}</span>
            </summary>
            <div className="form-grid">
              <label className="field">
                <span className="field-label">{learn ? 'Tutor style' : 'Interviewer'}</span>
                <select className="input" value={persona} onChange={(e) => setPersona(e.target.value)}>
                  <option value="">Default for this round ({opts.personas.find((p) => p.id === r?.persona)?.label})</option>
                  {opts.personas.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <VoiceSelect label={learn ? 'Tutor voice' : 'Interviewer voice'} value={voice} onChange={setVoice} opts={opts} dflt={learn ? opts.defaultTutorVoice : opts.defaultVoice} />
              <label className="field">
                <span className="field-label">When you finish answering</span>
                <select className="input" value={turnKey} onChange={(e) => setTurnKey(e.target.value)}>
                  {TURN_CHOICES.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Voice model</span>
                <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value="">Default for this round ({opts.models.find((m) => m.id === r?.model)?.label.split(':')[0]})</option>
                  {opts.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </details>
          <div className="start-row">
            <Btn
              kind="green"
              disabled={!!blocked}
              busyLabel="Connecting…"
              onClick={() =>
                onStart({
                  round,
                  mode,
                  ...(persona ? { persona } : {}),
                  ...(model ? { model } : {}),
                  ...(voice ? { voice } : {}),
                  turnTaking: turnChoice(turnKey).value,
                  ...(topic && r?.topicPick ? { topic } : {}),
                  ...(prepPack && r?.job !== 'none' ? { prepPack } : {}),
                })
              }
            >
              {learn ? 'Start lesson' : 'Start interview'}
            </Btn>
            {blocked && <span className="hint">{blocked}</span>}
          </div>
        </Card>
      </Section>
      <Section title="Past sessions">
        {opts.sessions.length ? (
          <ul className="history">
            {opts.sessions.map((s) => (
              <li key={s.id} className="history-row">
                <button type="button" className="history-open" onClick={() => onOpen(s.id)}>
                  <span className="history-title">
                    {opts.rounds.find((x) => x.id === s.round)?.label ?? s.round}
                    {s.mode === 'learn' && <Tag tone="dim">learn</Tag>}
                    {s.picked && <Tag tone="dim">your pick</Tag>}
                  </span>
                  <span className="history-meta">
                    {when(s.createdAt)}
                    {s.durationSeconds ? ` · ${mmss(s.durationSeconds)}` : ''}
                    {s.debriefs ? ` · ${s.debriefs} spoken review${s.debriefs === 1 ? '' : 's'}` : ''}
                  </span>
                </button>
                <span className="history-score">
                  {s.overall ? (
                    <Tag tone={scoreTone(s.overall)}>{s.overall}/10</Tag>
                  ) : s.status === 'live' ? (
                    <Tag tone="dim">not ended</Tag>
                  ) : s.gradingFailed ? (
                    <Tag tone="bad">grading failed</Tag>
                  ) : (
                    <Tag tone="dim">{s.grading ? 'grading…' : 'not graded'}</Tag>
                  )}
                </span>
                <DeleteButton id={s.id} onDeleted={onDeleted} />
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No sessions yet. Your first round shows up here with its score.</Empty>
        )}
      </Section>
    </>
  );
}

interface BankItem {
  id: string;
  folder: string;
  question: string;
  short: string;
  asked: number;
  lastScore: number | null;
  lastAsked: string | null;
  due: boolean;
}

const BANK_FILTERS: { id: string; label: string; test: (q: BankItem) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'new', label: 'Never asked', test: (q) => !q.asked },
  { id: 'due', label: 'Due for repeat', test: (q) => q.due },
  { id: 'weak', label: 'Last score under 6', test: (q) => q.lastScore !== null && q.lastScore < 6 },
];

/**
 * Every question in the bank with its answer. Read them, then start an interview or a lesson on one question,
 * or on a few you pick (asked in the order you picked them). Calls use the settings saved on the start form.
 */
function QuestionBank({ opts, micOk, onStart, onBack }: { opts: Options; micOk: boolean; onStart: (input: Record<string, unknown>) => Promise<void>; onBack: () => void }) {
  const [items, setItems] = useState<BankItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [topic, setTopic] = useRemembered<string>('vi.bankTopic', (v) => opts.topics.includes(v), '');
  const [filter, setFilter] = useState('all');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [notes, setNotes] = useState<Record<string, string | null>>({});
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    window.scrollTo(0, 0);
    get<BankItem[]>('api/questions').then(setItems, (e) => setErr((e as Error).message));
  }, []);

  const voice = opts.voices.some((v) => v.id === remembered('vi.voice')) ? remembered('vi.voice') : '';
  const turn = turnChoice(remembered('vi.turn'));
  const blocked = !opts.configured ? 'Set GEMINI_API_KEY in .env and restart the server to start a call.' : !micOk ? 'The microphone needs localhost or HTTPS.' : null;
  const start = (questions: string[], mode: 'interview' | 'learn') => onStart({ questions, mode, ...(voice ? { voice } : {}), turnTaking: turn.value });

  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  const test = BANK_FILTERS.find((f) => f.id === filter)?.test ?? (() => true);
  const shown = (items ?? []).filter((q) => (!topic || q.folder === topic) && test(q) && terms.every((t) => `${q.question}\n${q.short}`.toLowerCase().includes(t)));
  const folders = [...new Set(shown.map((q) => q.folder))];
  const full = picked.length >= opts.maxPicked;

  const toggleOpen = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const togglePick = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < opts.maxPicked ? [...p, id] : p));
  const pickAll = (ids: string[]) => setPicked((p) => [...p, ...ids.filter((id) => !p.includes(id))].slice(0, opts.maxPicked));
  const loadNotes = (id: string) => {
    setNotes((n) => ({ ...n, [id]: null }));
    get<{ notes: string }>(`api/question-notes?id=${encodeURIComponent(id)}`).then(
      (r) => setNotes((n) => ({ ...n, [id]: r.notes || 'No notes in this file.' })),
      (e) => setNotes((n) => ({ ...n, [id]: `Could not load the notes: ${(e as Error).message}` })),
    );
  };

  return (
    <>
      <div className="bank-top">
        <button type="button" className="btn ghost" onClick={onBack}>
          ← Back
        </button>
        <p className="hint">
          Calls use your saved settings: voice {voice || `default (${opts.defaultVoice} for interviews, ${opts.defaultTutorVoice} for lessons)`} · {turn.short}. Change them under Call settings on the start form.
        </p>
      </div>
      <Section title="Question bank" sub={items ? `${shown.length} of ${items.length} questions` : undefined}>
        <div className="bank-filters">
          <input className="input" type="search" placeholder="Search questions and answers" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search questions and answers" />
          <select className="input" value={topic} onChange={(e) => setTopic(e.target.value)} aria-label="Topic">
            <option value="">All topics</option>
            {opts.topics.map((t) => (
              <option key={t} value={t}>
                {folderLabel(t)}
              </option>
            ))}
          </select>
          <select className="input" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Show">
            {BANK_FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        {blocked && <p className="hint">{blocked}</p>}
        {err ? (
          <ErrorBar message={`Could not load the questions: ${err}`} />
        ) : !items ? (
          <div className="loading">Loading…</div>
        ) : !shown.length ? (
          <Empty>No questions match. Clear the search or pick another topic.</Empty>
        ) : (
          folders.map((f) => {
            const inFolder = shown.filter((q) => q.folder === f);
            return (
              <div key={f} className="bank-group">
                <div className="bank-folder">
                  <h3>{folderLabel(f)}</h3>
                  <span className="dim">{inFolder.length}</span>
                  <button type="button" className="linkish" onClick={() => pickAll(inFolder.map((q) => q.id))} disabled={full}>
                    Pick {inFolder.length > opts.maxPicked - picked.length ? `first ${Math.max(0, opts.maxPicked - picked.length)}` : 'all'}
                  </button>
                </div>
                <ul className="bank-list">
                  {inFolder.map((q) => {
                    const isOpen = open.has(q.id);
                    const n = notes[q.id];
                    const order = picked.indexOf(q.id);
                    return (
                      <li key={q.id} className={`bank-row ${order >= 0 ? 'picked' : ''}`}>
                        <input type="checkbox" className="bank-check" checked={order >= 0} disabled={order < 0 && full} onChange={() => togglePick(q.id)} aria-label={`Pick: ${q.question}`} />
                        <div className="bank-main">
                          <button type="button" className="bank-q" aria-expanded={isOpen} onClick={() => toggleOpen(q.id)}>
                            {order >= 0 && <span className="bank-order">{order + 1}</span>}
                            {q.question}
                          </button>
                          <div className="bank-meta">
                            {!q.asked ? <Tag tone="dim">new</Tag> : q.lastScore !== null ? <Tag tone={scoreTone(q.lastScore)}>last {q.lastScore}/10</Tag> : <Tag tone="dim">asked {q.asked}×</Tag>}
                            {q.due && <Tag tone="warn">due</Tag>}
                            {q.lastAsked && <span className="dim">asked {when(q.lastAsked)}</span>}
                            <button type="button" className="linkish" onClick={() => toggleOpen(q.id)}>
                              {isOpen ? 'Hide answer' : 'Show answer'}
                            </button>
                          </div>
                          {isOpen && (
                            <div className="bank-answer">
                              <Md text={typeof n === 'string' ? n : q.short || 'No short answer in this file.'} />
                              {n === undefined && (
                                <button type="button" className="linkish" onClick={() => loadNotes(q.id)}>
                                  Show full notes
                                </button>
                              )}
                              {n === null && <span className="dim">Loading the full notes…</span>}
                            </div>
                          )}
                        </div>
                        <div className="bank-actions">
                          <Btn kind="ghost" disabled={!!blocked} busyLabel="Connecting…" onClick={() => start([q.id], 'interview')}>
                            Interview
                          </Btn>
                          <Btn kind="ghost" disabled={!!blocked} busyLabel="Connecting…" onClick={() => start([q.id], 'learn')}>
                            Learn
                          </Btn>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })
        )}
      </Section>
      {picked.length > 0 && (
        <div className="bank-bar" role="region" aria-label="Picked questions">
          <b>
            {picked.length} picked{full ? ` (the most for one call)` : ''}
          </b>
          <Btn kind="green" disabled={!!blocked} busyLabel="Connecting…" onClick={() => start(picked, 'interview')}>
            Interview on {picked.length === 1 ? 'it' : 'these'}
          </Btn>
          <Btn disabled={!!blocked} busyLabel="Connecting…" onClick={() => start(picked, 'learn')}>
            Learn {picked.length === 1 ? 'it' : 'these'}
          </Btn>
          <button type="button" className="btn ghost" onClick={() => setPicked([])}>
            Clear
          </button>
        </div>
      )}
    </>
  );
}

/**
 * Forgets a session: its file, its report, and its effect on which questions come back. Asks first.
 * coach-notes.md keeps its summary (edit it by hand if needed).
 */
function DeleteButton({ id, onDeleted, label }: { id: string; onDeleted: () => void; label?: string }) {
  return (
    <button
      type="button"
      className="linkish danger"
      title="Delete this session"
      onClick={async () => {
        if (!window.confirm('Delete this session? Its transcript and review are removed, and its questions count as never asked (unless another session asked them). This cannot be undone.')) return;
        try {
          await del(`api/sessions/${id}`);
          onDeleted();
        } catch (e) {
          window.alert(`Could not delete: ${(e as Error).message}${e instanceof ApiError && e.unlock ? ' (sign in first)' : ''}`);
        }
      }}
    >
      {label ?? 'Delete'}
    </button>
  );
}

function Transcript({ turns, coach, tall, empty, endRef }: { turns: Turn[]; coach?: boolean; tall?: boolean; empty?: string; endRef?: Ref<HTMLDivElement> }) {
  return (
    <div className={`transcript ${tall ? 'tall' : ''}`}>
      {turns.length ? (
        turns.map((t, i) => (
          <div key={i} className={`turn ${t.who}`}>
            <span className="who">
              {t.who === 'interviewer' ? (coach ? 'Coach' : 'Interviewer') : 'You'} · {mmss(t.start)}
            </span>
            <p>{t.text}</p>
          </div>
        ))
      ) : (
        <Empty>{empty ?? 'Nothing yet.'}</Empty>
      )}
      <div ref={endRef} />
    </div>
  );
}

function Live({ session, onError, onDone }: { session: Session; onError: (e: unknown) => void; onDone: (id: string) => void }) {
  const [state, setState] = useState<LiveState>('connecting');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [calls, setCalls] = useState<ShownCall[]>([]);
  const [plan, setPlan] = useState(session.plan);
  const [lesson, setLesson] = useState<{ id: string; question: string; notes: string; hidden: boolean; peek: boolean } | null>(null);
  const [notes, setNotes] = useState<{ question_id: string; rating: number; note: string }[]>([]);
  const [showNotes, setShowNotes] = useState(false);
  /** Tool calls, ratings and the connection log: hidden by default, so the call feels like a call. Remembered. */
  const [showWork, setShowWork] = useState(() => remembered('vi.showWork') === '1');
  const [muted, setMuted] = useState(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const turnMode = session.turnTaking?.mode ?? 'auto';
  const [turnState, setTurnState] = useState<TurnState>('theirs');
  const turnRef = useRef<TurnState>('theirs');
  const [level, setLevel] = useState(0);
  /** The mic has been near silent for a while: the browser gets no sound (OS permission, wrong input). */
  const [micQuiet, setMicQuiet] = useState(false);
  const lastLoud = useRef(performance.now());
  /**
   * When the candidate actually spoke, from the mic level: the transcript of an answer arrives in one burst
   * after they stop, so its arrival time says nothing about how long they talked (words per minute needs this).
   */
  const speechStart = useRef<number | null>(null);
  const lastSpeech = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [saving, setSaving] = useState(false);
  const live = useRef<LiveInterview | null>(null);
  const conn = useRef<Handoff<NonNullable<typeof pendingLive>> | null>(null);
  const t0 = useRef(performance.now());
  const turnsRef = useRef<Turn[]>([]);
  const endAsked = useRef(false);
  const finished = useRef(false);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const logRef = useRef<LogEntry[]>([]);
  const logSent = useRef(0);
  const now = () => (performance.now() - t0.current) / 1000;
  const base = `api/sessions/${session.id}`;

  const addLog = (event: string, detail?: string) => {
    logRef.current.push({ t: Math.round(now() * 10) / 10, event, ...(detail ? { detail } : {}) });
    setLog([...logRef.current]);
  };
  /** Sends log entries the server has not had yet. */
  const flushLog = async (keepalive = false) => {
    const entries = logRef.current.slice(logSent.current);
    if (!entries.length) return;
    logSent.current = logRef.current.length;
    if (keepalive) return beacon(`${base}/log`, { entries });
    await post(`${base}/log`, { entries }).catch(() => {
      logSent.current -= entries.length;
    });
  };

  const finish = async (reason: string) => {
    if (finished.current) return;
    finished.current = true;
    setSaving(true);
    live.current?.stop();
    addLog('ending', reason);
    await flushLog();
    try {
      await post(`${base}/end`, { transcript: turnsRef.current, durationSeconds: Math.round(now()), reason });
      onDone(session.id);
    } catch (e) {
      onError(e);
      setSaving(false);
      finished.current = false;
    }
  };

  useEffect(() => {
    const first = takeHandoff(conn, () => {
      const pending = pendingLive;
      pendingLive = null;
      return pending;
    });
    if (!conn.current) {
      onError(new Error('The live connection was not created. Start again.'));
      return;
    }
    const c = conn.current;
    const addText = (who: Turn['who'], text: string) => {
      const t = now();
      const list = turnsRef.current;
      const last = list[list.length - 1];
      if (who === 'interviewer') {
        if (last && last.who === who) {
          last.text += text;
          last.end = t;
        } else {
          list.push({ who, text: text.trimStart(), start: t, end: t });
          speechStart.current = lastSpeech.current = null;
        }
      } else {
        const start = Math.min(speechStart.current ?? t, t);
        const end = Math.min(Math.max(lastSpeech.current ?? t, start), t);
        if (last && last.who === who) {
          last.text += text;
          last.end = Math.max(last.end, end);
        } else list.push({ who, text: text.trimStart(), start, end });
      }
      setTurns([...list]);
    };
    const runCalls = async (fcs: FunctionCall[]) =>
      Promise.all(
        fcs.map(async (fc) => {
          const key = `${fc.id}-${Date.now()}`;
          setCalls((c) => [...c, { key, name: fc.name, args: fc.args, at: now() }]);
          try {
            const rec = await post<ToolCallRecord>(`${base}/tool`, { name: fc.name, args: fc.args, t: now() });
            setCalls((c) => c.map((x) => (x.key === key ? { ...x, result: rec.result, ms: rec.ms, error: rec.error } : x)));
            if (fc.name === 'next_question') {
              const qid = (rec.result as { question_id?: string })?.question_id;
              if (qid) setPlan((p) => p.map((q) => (q.id === qid ? { ...q, asked: true } : q)));
            }
            // A question picked from an answer replaces a planned one: reload the plan.
            if (fc.name === 'related_question' && (rec.result as { found?: boolean })?.found) void get<Session>(base).then((x) => setPlan(x.plan));
            if (fc.name === 'record_note' && !rec.error) setNotes((n) => [...n, fc.args as { question_id: string; rating: number; note: string }]);
            if (fc.name === 'end_interview') endAsked.current = true;
            // Learn mode: the answer shows while the tutor teaches it, and hides when the explain-back starts.
            const res = rec.result as { question?: string; question_id?: string; notes?: string; answer?: string } | undefined;
            if (fc.name === 'next_question' && res?.question && (res.notes || res.answer))
              setLesson({ id: res.question_id ?? '', question: res.question, notes: res.notes || res.answer || '', hidden: false, peek: false });
            if (fc.name === 'start_recall' && !rec.error) setLesson((l) => (l ? { ...l, hidden: true, peek: false } : l));
            return { result: rec.result };
          } catch (e) {
            const message = (e as Error).message;
            setCalls((c) => c.map((x) => (x.key === key ? { ...x, error: message, result: { error: message } } : x)));
            return { error: message };
          }
        }),
      );
    const { li, started } = c.value;
    live.current = li;
    li.turnMode = turnMode;
    if (first) li.connect(started.live.wsUrl, started.live.token, started.live.setup, {
      onState: (st) => {
        setState(st);
        // Button mode: once it starts answering after your Done, the turn is theirs.
        if (st === 'speaking' && turnRef.current === 'waiting') setTurnState((turnRef.current = 'theirs'));
      },
      onTurn: (t) => setTurnState((turnRef.current = t)),
      onTranscript: addText,
      onToolCalls: runCalls,
      onTurnComplete: () => {
        if (endAsked.current) void live.current?.drained().then(() => finish('interviewer ended the interview'));
      },
      onLevel: (rms: number) => {
        setLevel(rms);
        if (rms > 0.01) lastLoud.current = performance.now();
        if (rms > 0.02 && !live.current?.playing) {
          const t = now();
          if (speechStart.current === null) speechStart.current = t;
          lastSpeech.current = t;
        }
      },
      onLog: addLog,
      onClose: (reason?: string) => {
        if (reason) void finish(`connection lost: ${reason}`);
      },
    }, started.live.kickoff).catch((e) => {
      onError(e);
      void finish(`could not start: ${(e as Error).message}`);
    });
    let quietLogged = false;
    const timer = setInterval(() => {
      setElapsed(now());
      // Not a mic problem while paused, or in button mode while it is not your turn.
      if (pausedRef.current || (turnMode === 'button' && turnRef.current !== 'yours')) lastLoud.current = performance.now();
      const quiet = performance.now() - lastLoud.current > 12_000;
      setMicQuiet(quiet);
      if (quiet && !quietLogged) {
        quietLogged = true;
        addLog('mic silent', 'no sound above the noise floor for 12 s');
      }
      if (!quiet) quietLogged = false;
    }, 1000);
    const logTimer = setInterval(() => void flushLog(), 3000);
    // Closing or reloading the tab still saves the session (log, transcript so far) instead of leaving it live.
    const onHide = () => {
      if (finished.current) return;
      finished.current = true;
      addLog('page closed');
      void flushLog(true);
      beacon(`${base}/end`, { transcript: turnsRef.current, durationSeconds: Math.round(now()), reason: 'page closed' });
    };
    const onErr = (e: ErrorEvent) => {
      addLog('page error', `${e.message} @ ${e.filename?.split('/').pop()}:${e.lineno}:${e.colno}`);
      void flushLog(true);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      addLog('unhandled rejection', String((e.reason as Error)?.message ?? e.reason).slice(0, 300));
      void flushLog(true);
    };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRejection);
    if (first) addLog('browser', navigator.userAgent);
    return () => {
      clearInterval(timer);
      clearInterval(logTimer);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onRejection);
      c.stopTimer = setTimeout(() => li.stop(), 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Braces matter: newer Chrome returns a Promise from scrollIntoView, and an effect must return nothing or
  // a cleanup function (returning the Promise crashes the page).
  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [turns]);

  const asked = plan.filter((q) => q.asked).length;
  const learn = session.mode === 'learn';
  const togglePause = () => {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    void live.current?.setPaused(next);
  };
  const toggleWork = () => {
    setShowWork(!showWork);
    remember('vi.showWork', showWork ? '' : '1');
  };
  const stateLabel = learn && state === 'speaking' ? 'Tutor speaking' : STATE_LABEL[state];
  return (
    <>
      {paused && <PausedCover onResume={togglePause} />}
      <section className={`callpanel ${state === 'closed' ? '' : 'live'}`} aria-label={learn ? 'Lesson' : 'Interview call'}>
        <div className="callpanel-top">
          {/* Announced to screen readers when it changes; the timer stays outside so it isn't read every second. */}
          <span className="callstate" role="status" aria-live="polite">
            <Tag tone={state === 'speaking' ? 'warn' : state === 'listening' ? 'ok' : 'dim'}>{stateLabel}</Tag>
            {learn && <Tag>Learn mode</Tag>}
            <span>
              Question {Math.max(asked, 1)} of {plan.length}
            </span>
          </span>
          <b className="timer">{mmss(elapsed)}</b>
          <span className="meter" aria-hidden="true">
            <span style={{ width: `${Math.min(100, Math.round(level * 400))}%` }} />
          </span>
        </div>
        <p className="callhint">
          {learn ? 'Say “explain again”, “example”, “next” or “stop” any time.' : 'Say “hint”, “repeat” or “skip” any time.'}
          {turnMode === 'button' ? ' Press Space when you finish answering.' : ''}
        </p>
        <div className="callbar">
          <CallControls li={live.current} turnMode={turnMode} turn={turnState} state={state} paused={paused} onPause={togglePause} />
          <Btn
            kind="ghost"
            onClick={() => {
              live.current?.setMuted(!muted);
              setMuted(!muted);
            }}
          >
            {muted ? 'Unmute' : 'Mute'}
          </Btn>
          <span className="callbar-end">
            <ConfirmButton disabled={saving} confirmLabel="Press again to end" onConfirm={() => finish('ended on the page')}>
              {saving ? 'Saving…' : learn ? 'End lesson' : 'End interview'}
            </ConfirmButton>
          </span>
        </div>
      </section>
      {micQuiet && !muted && (
        <div className="nowbar warn" role="alert">
          <Tag tone="warn">Mic silent</Tag> The page gets no sound from your microphone, so the {learn ? 'tutor' : 'interviewer'} can't hear you. Check the mic icon in the browser's address bar, your system's microphone permission for the browser, and that the input level moves when you talk.
        </div>
      )}
      {learn && (
        <Section title="Study card" sub={lesson ? (lesson.hidden ? 'answer hidden: explain it back in your own words' : 'read along while the tutor teaches; ask any doubt') : 'the answer shows here with each question'}>
          {lesson ? (
            <Card tone={lesson.hidden ? 'warn' : 'accent'}>
              <b className="lesson-q">{lesson.question}</b>
              {lesson.hidden && !lesson.peek ? (
                <p className="hint">
                  Explain it back now, as you would in an interview.{' '}
                  <button type="button" className="linkish" onClick={() => setLesson((l) => (l ? { ...l, peek: true } : l))}>
                    Peek at the answer
                  </button>
                </p>
              ) : (
                <Md text={lesson.notes} />
              )}
            </Card>
          ) : (
            <Empty>Waiting for the first question…</Empty>
          )}
        </Section>
      )}
      <div className={showWork ? 'live-grid' : ''}>
        <div>
          <Section
            title="Conversation"
            sub="live transcript"
            actions={
              <button type="button" className="linkish" aria-expanded={showWork} onClick={toggleWork}>
                {showWork ? 'Hide' : 'Show'} what the {learn ? 'tutor' : 'interviewer'} is doing ({calls.length})
              </button>
            }
          >
            <Transcript turns={turns} empty={`Waiting for the ${learn ? 'tutor' : 'interviewer'} to start…`} endRef={transcriptEnd} />
          </Section>
          <Section title="Plan" sub={`${asked}/${plan.length} asked`}>
            <ol className="plan">
              {plan.map((q) => (
                <li key={q.id} className={q.asked ? '' : 'dim'}>
                  {q.asked ? q.question : 'Not asked yet'} {q.added && <Tag tone="ok">from your answer</Tag>}
                </li>
              ))}
            </ol>
          </Section>
        </div>
        {showWork && (
          <Section
            title="Tool calls"
            sub={`${calls.length} so far`}
            actions={
              <button type="button" className="linkish" onClick={() => setShowNotes(!showNotes)}>
                {showNotes ? 'Hide' : 'Show'} ratings ({notes.length})
              </button>
            }
          >
            {showNotes && notes.length > 0 && (
              <Card>
                {notes.map((n, i) => (
                  <div key={i}>
                    <Tag tone={scoreTone(n.rating)}>{n.rating}/10</Tag> {n.note}
                  </div>
                ))}
              </Card>
            )}
            <div className="calls">
              {calls.length ? [...calls].reverse().map((c, i) => <CallCard key={c.key} call={c} open={i === 0} hideResult={c.name === 'record_note' && !showNotes} />) : <Empty>No tool calls yet.</Empty>}
            </div>
            <ConnectionLog entries={log} />
          </Section>
        )}
      </div>
    </>
  );
}

/**
 * The review, spoken: a coach voice walks through Claude's review answer by answer, reads the stronger
 * answers, and lets the candidate practise them out loud. The transcript is kept with the session.
 */
function Debrief({ sessionId, voice, turnMode, onDone }: { sessionId: string; voice: string; turnMode: 'auto' | 'button'; onDone: () => void }) {
  const [state, setState] = useState<LiveState>('connecting');
  const [paused, setPaused] = useState(false);
  const [turnState, setTurnState] = useState<TurnState>('theirs');
  const turnRef = useRef<TurnState>('theirs');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const live = useRef<LiveInterview | null>(null);
  const t0 = useRef(performance.now());
  const turnsRef = useRef<Turn[]>([]);
  const endAsked = useRef(false);
  const finished = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  const conn = useRef<Handoff<NonNullable<typeof pendingDebrief>> | null>(null);
  const now = () => (performance.now() - t0.current) / 1000;
  const url = `api/sessions/${sessionId}/debrief/end`;

  const finish = async () => {
    if (finished.current) return;
    finished.current = true;
    live.current?.stop();
    await post(url, { transcript: turnsRef.current, durationSeconds: Math.round(now()), voice }).catch(() => undefined);
    onDone();
  };

  useEffect(() => {
    const first = takeHandoff(conn, () => {
      const pending = pendingDebrief;
      pendingDebrief = null;
      return pending;
    });
    if (!conn.current) {
      setError('The voice connection was not created. Press Listen again.');
      return;
    }
    const c = conn.current;
    const { li, live: started } = c.value;
    live.current = li;
    li.turnMode = turnMode;
    if (first) li.connect(
      started.wsUrl,
      started.token,
      started.setup,
      {
        onState: (st) => {
          setState(st);
          if (st === 'speaking' && turnRef.current === 'waiting') setTurnState((turnRef.current = 'theirs'));
        },
        onTurn: (t) => setTurnState((turnRef.current = t)),
        onTranscript: (who, text) => {
          const t = now();
          const list = turnsRef.current;
          const last = list[list.length - 1];
          if (last && last.who === who) {
            last.text += text;
            last.end = t;
          } else list.push({ who, text: text.trimStart(), start: t, end: t });
          setTurns([...list]);
        },
        onToolCalls: async (calls) =>
          calls.map((c) => {
            if (c.name === 'end_debrief') endAsked.current = true;
            return { ok: true };
          }),
        onTurnComplete: () => {
          if (endAsked.current) void li.drained().then(finish);
        },
        onLevel: setLevel,
        onClose: (reason) => {
          if (reason) {
            setError(`Connection lost: ${reason}`);
            void finish();
          }
        },
        onLog: () => undefined,
      },
      '(The candidate has opened the debrief. Start now.)',
    ).catch((e) => {
      setError((e as Error).message);
      void finish();
    });
    const timer = setInterval(() => setElapsed(now()), 1000);
    const onHide = () => {
      if (finished.current) return;
      finished.current = true;
      beacon(url, { transcript: turnsRef.current, durationSeconds: Math.round(now()), voice });
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pagehide', onHide);
      c.stopTimer = setTimeout(() => li.stop(), 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [turns]);

  const togglePause = () => {
    const next = !paused;
    setPaused(next);
    void live.current?.setPaused(next);
  };
  return (
    <Section title="Spoken review" sub="say “next”, “repeat”, “slower”, “why”, or “stop”; try the stronger answers out loud">
      {paused && <PausedCover onResume={togglePause} />}
      <div className="nowbar live">
        <span role="status" aria-live="polite">
          <Tag tone={state === 'speaking' ? 'warn' : state === 'listening' ? 'ok' : 'dim'}>{state === 'speaking' ? 'Coach speaking' : STATE_LABEL[state]}</Tag>
        </span>
        <b>{mmss(elapsed)}</b>
        <span className="meter" aria-hidden="true">
          <span style={{ width: `${Math.min(100, Math.round(level * 400))}%` }} />
        </span>
        <span className="controls">
          <CallControls li={live.current} turnMode={turnMode} turn={turnState} state={state} paused={paused} onPause={togglePause} />
          <Btn kind="danger" onClick={finish}>
            End review
          </Btn>
        </span>
      </div>
      {error && <ErrorBar message={error} />}
      <Transcript turns={turns} coach empty="The coach is getting ready…" endRef={end} />
    </Section>
  );
}

/** A crash while drawing the live view: show it and save it to the session log instead of a blank page. */
class LiveGuard extends Component<{ sessionId: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    beacon(`api/sessions/${this.props.sessionId}/log`, { entries: [{ t: 0, event: 'page crashed', detail: `${error.message} | ${String(error.stack ?? '').split('\n').slice(0, 4).join(' | ')}` }] });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="nowbar">
        <Tag tone="bad">Page crashed</Tag> {this.state.error.message}. It was saved to the session log. Reload to try again.
      </div>
    );
  }
}

/** Gemini Live events as they happen (also saved with the session). */
function ConnectionLog({ entries }: { entries: LogEntry[] }) {
  return (
    <details className="call log">
      <summary>
        <b>Connection log</b> <span className="dim">{entries.length} events</span>
      </summary>
      <pre>
        {entries.length
          ? [...entries]
              .reverse()
              .slice(0, 300)
              .map((e) => `${mmss(e.t)}  ${e.event}${e.detail ? `  ${e.detail}` : ''}`)
              .join('\n')
          : 'Nothing yet.'}
      </pre>
    </details>
  );
}

function CallCard({ call, open, hideResult }: { call: ShownCall; open: boolean; hideResult?: boolean }) {
  const running = call.result === undefined && !call.error;
  return (
    <details className={`call ${call.error ? 'bad' : running ? 'running' : ''}`} open={open}>
      <summary>
        <code>{call.name}</code> <span className="dim">{mmss(call.at)}</span> {running ? <Tag tone="warn">running</Tag> : call.error ? <Tag tone="bad">error</Tag> : <Tag tone="ok">{call.ms} ms</Tag>}
      </summary>
      <div className="call-body">
        <span className="field-label">Arguments</span>
        <pre>{Object.keys(call.args).length ? JSON.stringify(hideResult ? { ...call.args, rating: '·', note: '·' } : call.args, null, 2) : '{}'}</pre>
        {!running && (
          <>
            <span className="field-label">Result</span>
            <pre>{JSON.stringify(hideResult ? '·' : call.result, null, 2)}</pre>
          </>
        )}
      </div>
    </details>
  );
}

function Pending({ s, opts, onRetry }: { s: Session; opts: Options; onRetry: () => Promise<void> }) {
  const promptUrl = `api/sessions/${s.id}/review-prompt`;
  const byHand = (
    <p className="hint">
      To grade by hand: open the <a href={promptUrl} target="_blank" rel="noopener">review prompt</a>, paste it into any Claude chat, save the JSON reply as <code>review.json</code>, then run{' '}
      <code>curl -X POST {new URL(`api/sessions/${s.id}/review`, window.location.href).href} -H 'content-type: application/json' --data @review.json</code>
      .
    </p>
  );
  if (s.status === 'live')
    return (
      <Card tone="accent">
        <b>This session never ended.</b>
      </Card>
    );
  if (!s.transcript.some((t) => t.who === 'candidate'))
    return (
      <Card tone="accent">
        <b>Nothing to grade</b>
        <p className="hint">No answers were recorded in this call.</p>
      </Card>
    );
  if (s.reviewError)
    return (
      <Card tone="bad" role="alert">
        <b>Grading failed</b>
        <p>{friendlyError(s.reviewError).text}</p>
        {friendlyError(s.reviewError).detail && <p className="hint">{s.reviewError}</p>}
        {opts.grading && (
          <Btn kind="green" onClick={onRetry}>
            Try again
          </Btn>
        )}
        {byHand}
      </Card>
    );
  if (s.grading) {
    // The server allows a new attempt after 10 minutes (POST .../grade).
    const stale = Date.now() - Date.parse(s.grading.startedAt) > 10 * 60_000;
    return (
      <Card tone="accent">
        <b>Claude is grading the call</b>
        <p className="hint">It scores each answer and writes a stronger way to say it. This usually takes a minute or two; the page checks every 10 seconds.</p>
        {stale && (
          <>
            <p className="hint">This is taking much longer than usual.</p>
            <Btn kind="green" onClick={onRetry}>
              Try again
            </Btn>
          </>
        )}
      </Card>
    );
  }
  if (opts.grading)
    return (
      <Card tone="accent">
        <b>Not graded yet</b>
        <p className="hint">Grading never started for this call.</p>
        <Btn kind="green" onClick={onRetry}>
          Grade now
        </Btn>
        {byHand}
      </Card>
    );
  return (
    <Card tone="accent">
      <b>Grading is off</b>
      <p className="hint">
        Set <code>ANTHROPIC_API_KEY</code> in <code>.env</code> and restart to grade every call automatically.
      </p>
      {byHand}
    </Card>
  );
}

function Done({ id, opts, onBack }: { id: string; opts: Options; onBack: () => void }) {
  const [coachVoice, setCoachVoiceState] = useState(() => remembered('vi.coachVoice'));
  const [usedVoice, setUsedVoice] = useState(opts.defaultVoice);
  const setCoachVoice = (v: string) => {
    setCoachVoiceState(v);
    remember('vi.coachVoice', v);
  };
  const [s, setS] = useState<Session | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [debriefTurn, setDebriefTurn] = useState<'auto' | 'button'>('auto');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () =>
      get<Session>(`api/sessions/${id}`).then(
        (x) => {
          if (stop) return;
          setS(x);
          // Only while grading really runs: the server sets the flag before /end or /grade answers.
          if (x.status === 'ended' && x.grading && !x.reviewError) timer = setTimeout(tick, 10_000);
        },
        (e) => setErr(e.message),
      );
    void tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, reload]);

  if (!s) return <div className="loading">{err ?? 'Loading the session…'}</div>;
  const m = s.metrics;
  const wpm = m?.wordsPerMinute && m.wordsPerMinute >= 60 && m.wordsPerMinute <= 260 ? m.wordsPerMinute : null;
  const canTalk = window.isSecureContext && !!navigator.mediaDevices && opts.configured;
  const roundLabel = opts.rounds.find((r) => r.id === s.round)?.label ?? s.round;
  const learn = s.mode === 'learn';
  const listen = async () => {
    setErr(null);
    const li = new LiveInterview();
    try {
      await li.prepareAudio();
      const turnTaking = turnChoice(remembered('vi.turn')).value;
      const live = await post<LiveStart & { voice: string; turnTaking: TurnTaking }>(`api/sessions/${id}/debrief`, {
        ...(opts.voices.some((v) => v.id === coachVoice) ? { voice: coachVoice } : {}),
        turnTaking,
      });
      setUsedVoice(live.voice);
      setDebriefTurn(live.turnTaking?.mode ?? 'auto');
      pendingDebrief = { li, live };
      setListening(true);
    } catch (e) {
      li.stop();
      setErr((e as Error).message);
    }
  };
  // The start form opens on this round and mode next time.
  const again = () => {
    remember('vi.round', s.round);
    remember('vi.mode', s.mode ?? 'interview');
    onBack();
  };
  return (
    <>
      <div className="done-head">
        <Btn kind="ghost" onClick={onBack}>
          ← New round
        </Btn>
        <span className="dim">
          {roundLabel}
          {learn ? ' · learn mode' : ''} · {when(s.createdAt)}
          {s.durationSeconds ? ` · ${mmss(s.durationSeconds)}` : ''}
        </span>
      </div>
      {err && <ErrorBar message={err} />}
      {s.review ? (
        <section className={`verdict ${scoreTone(s.review.overall)}`} aria-label="Verdict">
          <div className="verdict-score">
            <span className="verdict-num">
              {s.review.overall}
              <small>/10</small>
            </span>
            <span className="verdict-label">overall</span>
          </div>
          <div className="verdict-body">
            <p className="verdict-summary">{s.review.summary}</p>
            {s.review.next_focus.length > 0 && (
              <>
                <h2 className="verdict-h">Next time, focus on</h2>
                <ul className="verdict-focus">
                  {s.review.next_focus.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </>
            )}
            {!listening && (
              <div className="verdict-actions">
                <Btn kind="green" disabled={!canTalk} busyLabel="Connecting…" title={canTalk ? undefined : 'Needs the microphone and GEMINI_API_KEY'} onClick={listen}>
                  <SpeakerIcon />
                  Listen to the review
                </Btn>
                <span className="voice-pick">
                  <VoiceSelect label="Coach voice" value={coachVoice} onChange={setCoachVoice} opts={opts} />
                </span>
                <Btn kind="ghost" onClick={again}>
                  Practise this round again
                </Btn>
              </div>
            )}
          </div>
        </section>
      ) : (
        <Pending
          s={s}
          opts={opts}
          onRetry={async () => {
            setErr(null);
            await post(`api/sessions/${id}/grade`).catch((e) => setErr((e as Error).message));
            setReload((n) => n + 1);
          }}
        />
      )}
      {listening && (
        <Debrief
          sessionId={id}
          voice={usedVoice}
          turnMode={debriefTurn}
          onDone={() => {
            setListening(false);
            setReload((n) => n + 1);
          }}
        />
      )}
      {m && (
        <Section title="Delivery" sub={s.review?.delivery}>
          <div className="stats">
            <Stat label="words / min" value={wpm ?? '–'} note="calm: 120 to 160" tone={wpm && (wpm < 110 || wpm > 175) ? 'warn' : undefined} />
            <Stat label="fillers / min" value={m.fillersPerMinute ?? '–'} note="aim under 3" tone={(m.fillersPerMinute ?? 0) > 3 ? 'warn' : undefined} />
            <Stat label="words / sentence" value={m.avgWordsPerSentence ?? '–'} note="aim under 20" tone={(m.avgWordsPerSentence ?? 0) > 22 ? 'warn' : undefined} />
            <Stat label="longest answer" value={mmss(m.longestAnswerSeconds)} note="aim under 3 min" tone={m.longestAnswerSeconds > 180 ? 'warn' : undefined} />
            <Stat label="sir / sorry" value={`${m.sirMadam} / ${m.apologies}`} note="aim for none" tone={m.sirMadam + m.apologies ? 'warn' : undefined} />
          </div>
        </Section>
      )}
      {s.review && (
        <Section title="Answers">
          {s.review.answers.map((a, i) => (
            <Card key={i} tone={scoreTone(a.score)}>
              <h3 className="answer-q">
                <Tag tone={scoreTone(a.score)}>{a.score}/10</Tag> {a.question}
              </h3>
              <ul>
                <li>
                  <b>Content:</b> {a.technical}
                </li>
                <li>
                  <b>Structure:</b> {a.structure}
                </li>
                <li>
                  <b>Delivery:</b> {a.delivery}
                </li>
                <li>
                  <b>Fix next time:</b> {a.fix}
                </li>
              </ul>
              <span className="field-label">A stronger way to say it</span>
              <blockquote className="rewrite">{a.rewrite}</blockquote>
            </Card>
          ))}
        </Section>
      )}
      {s.debriefs?.length ? (
        <Section title="Spoken reviews" sub={`${s.debriefs.length} · also in reports/${id}.md`}>
          {[...s.debriefs].reverse().map((d, i) => (
            <details key={d.at} className="call" open={i === 0}>
              <summary>
                {when(d.at)} · {mmss(d.durationSeconds)}
                {d.voice ? ` · ${d.voice}` : ''}
              </summary>
              <Transcript turns={d.transcript} coach tall />
            </details>
          ))}
        </Section>
      ) : null}
      <Section title="Transcript">
        <Transcript turns={s.transcript} tall />
      </Section>
      <details className="details-foot">
        <summary>
          Session details <span className="dim">id, model, tool calls, connection log, delete</span>
        </summary>
        <p className="dim">
          {id}
          {s.turnTaking?.mode === 'button' ? ' · Done button' : ''}
          {s.model ? ` · ${s.model}` : ''}
          {s.review?.reviewer ? ` · graded by ${s.review.reviewer}` : ''} ·{' '}
          <a href={`api/sessions/${id}`} target="_blank" rel="noopener">
            raw JSON
          </a>
        </p>
        <Section title="Tool calls" sub={`${s.toolCalls.length}`}>
          <div className="calls">
            {s.toolCalls.length ? (
              s.toolCalls.map((c, i) => <CallCard key={i} call={{ key: String(i), name: c.name, args: c.args, at: (Date.parse(c.at) - Date.parse(s.toolCalls[0].at)) / 1000, result: c.result, ms: c.ms, error: c.error }} open={false} />)
            ) : (
              <Empty>No tool calls in this session.</Empty>
            )}
          </div>
        </Section>
        {s.debug?.length ? <ConnectionLog entries={s.debug} /> : null}
        <p>
          <DeleteButton id={id} onDeleted={onBack} label="Delete this session" />
        </p>
      </details>
    </>
  );
}
