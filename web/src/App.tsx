import { Component, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { beacon, get, post } from './api';
import { LiveInterview, type FunctionCall, type LiveState } from './live';
import { Btn, Card, Empty, Section, Stat, Tag, ago, mmss, scoreTone } from './ui';

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
}

interface Options {
  configured: boolean;
  grading: boolean;
  workspaceReady: boolean;
  questionCount: number;
  models: { id: string; label: string; model: string }[];
  voices: { id: string; style: string }[];
  defaultVoice: string;
  rounds: RoundInfo[];
  personas: { id: string; label: string }[];
  topics: string[];
  prepPacks: { file: string; title: string }[];
  dueCount: number;
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
  model?: string;
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

type LiveStart = { wsUrl: string; token: string; setup: { setup: Record<string, unknown> } };
type StartResult = { session: Session; live: LiveStart };

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

/** Handed from the Start click to the live view: audio is set up inside the click (browsers allow it only then). */
let pendingLive: { li: LiveInterview; started: StartResult } | null = null;
/** Handed from the Listen click to the debrief view. */
let pendingDebrief: { li: LiveInterview; live: LiveStart } | null = null;

export default function App() {
  const [opts, setOpts] = useState<Options | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<{ kind: 'setup' } | { kind: 'live'; session: Session } | { kind: 'done'; id: string }>({ kind: 'setup' });

  const load = () => get<Options>('/api/options').then(setOpts, (e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  const micOk = window.isSecureContext && !!navigator.mediaDevices;

  return (
    <main className="main">
      <header className="page-head">
        <div>
          <h1>Voice Interviewer</h1>
          <p className="sub">A live voice interviewer built from your own questions, profile and prep packs. Every tool it calls shows on screen. Claude scores the call afterwards.</p>
        </div>
      </header>
      {!opts ? (
        <div className="loading">{error ? `Could not reach the server: ${error}` : 'Loading…'}</div>
      ) : (
        <>
          {error && (
            <div className="nowbar">
              <Tag tone="bad">Error</Tag> {error}
            </div>
          )}
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
            <Setup
              opts={opts}
              canStart={opts.configured && opts.workspaceReady && micOk}
              onStart={async (input) => {
                setError(null);
                const li = new LiveInterview();
                try {
                  await li.prepareAudio();
                  const r = await post<StartResult>('/api/sessions', input);
                  pendingLive = { li, started: r };
                  setView({ kind: 'live', session: r.session });
                } catch (e) {
                  li.stop();
                  setError((e as Error).message);
                }
              }}
              onOpen={(id) => setView({ kind: 'done', id })}
            />
          )}
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

function VoiceSelect({ label, value, onChange, opts }: { label: string; value: string; onChange: (v: string) => void; opts: Options }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">
          Default ({opts.defaultVoice}, {opts.voices.find((v) => v.id === opts.defaultVoice)?.style.toLowerCase()})
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

function Setup({ opts, canStart, onStart, onOpen }: { opts: Options; canStart: boolean; onStart: (input: Record<string, string>) => Promise<void>; onOpen: (id: string) => void }) {
  const [round, setRound] = useState(opts.rounds[0]?.id ?? '');
  const r = opts.rounds.find((x) => x.id === round) ?? opts.rounds[0];
  const [persona, setPersona] = useState('');
  const [topic, setTopic] = useState('');
  const [prepPack, setPrepPack] = useState('');
  const [model, setModel] = useState('');
  const [voice, setVoiceState] = useState(() => remembered('vi.voice'));
  const setVoice = (v: string) => {
    setVoiceState(v);
    remember('vi.voice', v);
  };
  const needsPack = r?.job === 'required';

  return (
    <>
      <Section title="Start a round" sub={`${opts.questionCount} questions in your bank · ${opts.dueCount ? `${opts.dueCount} due for repeat` : 'no repeats due'}`}>
        <Card>
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
            <label className="field">
              <span className="field-label">Interviewer</span>
              <select className="input" value={persona} onChange={(e) => setPersona(e.target.value)}>
                <option value="">Default for this round ({opts.personas.find((p) => p.id === r?.persona)?.label})</option>
                {opts.personas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Model</span>
              <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">Default for this round ({opts.models.find((m) => m.id === r?.model)?.label.split(':')[0]})</option>
                {opts.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <VoiceSelect label="Interviewer voice" value={voice} onChange={setVoice} opts={opts} />
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
            <p className="hint wide">
              {r?.about} {r?.questions} main question{r?.questions === 1 ? '' : 's'}, {r?.followUps ? `up to ${r.followUps} follow ups each` : 'no follow ups'}. Headphones stop its voice leaking into your mic. Say “hint”, “repeat” or “skip” any time.
            </p>
          </div>
          <Btn
            kind="green"
            disabled={!canStart || !r || (needsPack && !prepPack)}
            onClick={() =>
              onStart({
                round,
                ...(persona ? { persona } : {}),
                ...(model ? { model } : {}),
                ...(voice && opts.voices.some((v) => v.id === voice) ? { voice } : {}),
                ...(topic && r?.topicPick ? { topic } : {}),
                ...(prepPack && r?.job !== 'none' ? { prepPack } : {}),
              })
            }
          >
            Start interview
          </Btn>
        </Card>
      </Section>
      <Section title="Past sessions">
        {opts.sessions.length ? (
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {opts.sessions.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <button type="button" className="linkish" onClick={() => onOpen(s.id)}>
                        {opts.rounds.find((x) => x.id === s.round)?.label ?? s.round}
                      </button>
                    </td>
                    <td className="dim">{ago(s.createdAt)}</td>
                    <td className="dim">{s.model?.includes('thinking') ? 'thinking' : 'fast'}</td>
                    <td className="dim">{s.durationSeconds ? mmss(s.durationSeconds) : '–'}</td>
                    <td className="dim">{s.debriefs ? `🔊 ${s.debriefs}` : ''}</td>
                    <td>{s.overall ? <Tag tone={scoreTone(s.overall)}>{s.overall}/10</Tag> : <Tag tone="dim">{s.status === 'live' ? 'not ended' : 'review pending'}</Tag>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No sessions yet.</Empty>
        )}
      </Section>
    </>
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
  const [notes, setNotes] = useState<{ question_id: string; rating: number; note: string }[]>([]);
  const [showNotes, setShowNotes] = useState(false);
  const [muted, setMuted] = useState(false);
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
  const t0 = useRef(performance.now());
  const turnsRef = useRef<Turn[]>([]);
  const endAsked = useRef(false);
  const finished = useRef(false);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const logRef = useRef<LogEntry[]>([]);
  const logSent = useRef(0);
  const now = () => (performance.now() - t0.current) / 1000;
  const base = `/api/sessions/${session.id}`;

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
    const pending = pendingLive;
    pendingLive = null;
    if (!pending) {
      onError(new Error('The live connection was not created. Start again.'));
      return;
    }
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
            const rec = await post<ToolCallRecord>(`${base}/tool`, { name: fc.name, args: fc.args });
            setCalls((c) => c.map((x) => (x.key === key ? { ...x, result: rec.result, ms: rec.ms, error: rec.error } : x)));
            if (fc.name === 'next_question') {
              const qid = (rec.result as { question_id?: string })?.question_id;
              if (qid) setPlan((p) => p.map((q) => (q.id === qid ? { ...q, asked: true } : q)));
            }
            // A question picked from an answer replaces a planned one: reload the plan.
            if (fc.name === 'related_question' && (rec.result as { found?: boolean })?.found) void get<Session>(base).then((x) => setPlan(x.plan));
            if (fc.name === 'record_note' && !rec.error) setNotes((n) => [...n, fc.args as { question_id: string; rating: number; note: string }]);
            if (fc.name === 'end_interview') endAsked.current = true;
            return { result: rec.result };
          } catch (e) {
            const message = (e as Error).message;
            setCalls((c) => c.map((x) => (x.key === key ? { ...x, error: message, result: { error: message } } : x)));
            return { error: message };
          }
        }),
      );
    const { li, started } = pending;
    live.current = li;
    li.connect(started.live.wsUrl, started.live.token, started.live.setup, {
      onState: setState,
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
    }).catch((e) => {
      onError(e);
      void finish(`could not start: ${(e as Error).message}`);
    });
    let quietLogged = false;
    const timer = setInterval(() => {
      setElapsed(now());
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
    addLog('browser', navigator.userAgent);
    return () => {
      clearInterval(timer);
      clearInterval(logTimer);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onRejection);
      li.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Braces matter: newer Chrome returns a Promise from scrollIntoView, and an effect must return nothing or
  // a cleanup function (returning the Promise crashes the page).
  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [turns]);

  const asked = plan.filter((q) => q.asked).length;
  return (
    <>
      <div className={`nowbar ${state === 'closed' ? '' : 'live'}`}>
        <Tag tone={state === 'speaking' ? 'warn' : state === 'listening' ? 'ok' : 'dim'}>{STATE_LABEL[state]}</Tag>
        <b>{mmss(elapsed)}</b>
        <span className="dim">
          Question {Math.max(asked, 1)} of {plan.length}
        </span>
        <span className="meter" aria-label="Microphone level">
          <span style={{ width: `${Math.min(100, Math.round(level * 400))}%` }} />
        </span>
        <span className="controls">
          <Btn
            kind="ghost"
            onClick={() => {
              live.current?.setMuted(!muted);
              setMuted(!muted);
            }}
          >
            {muted ? 'Unmute' : 'Mute'}
          </Btn>
          <Btn kind="danger" disabled={saving} onClick={() => finish('ended on the page')}>
            {saving ? 'Saving…' : 'End interview'}
          </Btn>
        </span>
      </div>
      {micQuiet && !muted && (
        <div className="nowbar">
          <Tag tone="warn">Mic silent</Tag> The page gets no sound from your microphone, so the interviewer can't hear you. Check the mic icon in the browser's address bar, your
          system's microphone permission for the browser, and that the input level moves when you talk.
        </div>
      )}
      <div className="live-grid">
        <Section title="Conversation" sub="live transcript">
          <Transcript turns={turns} empty="Waiting for the interviewer to start…" endRef={transcriptEnd} />
          <Section title="Plan" sub={`${asked}/${plan.length} asked`}>
            <ol className="plan">
              {plan.map((q) => (
                <li key={q.id} className={q.asked ? '' : 'dim'}>
                  {q.asked ? q.question : 'Not asked yet'} {q.added && <Tag tone="ok">from your answer</Tag>}
                </li>
              ))}
            </ol>
          </Section>
        </Section>
        <Section
          title="Tool calls"
          sub={`${calls.length} so far`}
          actions={
            <button type="button" className="linkish" onClick={() => setShowNotes(!showNotes)}>
              {showNotes ? 'Hide' : 'Show'} interviewer ratings ({notes.length})
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
      </div>
    </>
  );
}

/**
 * The review, spoken: a coach voice walks through Claude's review answer by answer, reads the stronger
 * answers, and lets the candidate practise them out loud. The transcript is kept with the session.
 */
function Debrief({ sessionId, voice, onDone }: { sessionId: string; voice: string; onDone: () => void }) {
  const [state, setState] = useState<LiveState>('connecting');
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
  const now = () => (performance.now() - t0.current) / 1000;
  const url = `/api/sessions/${sessionId}/debrief/end`;

  const finish = async () => {
    if (finished.current) return;
    finished.current = true;
    live.current?.stop();
    await post(url, { transcript: turnsRef.current, durationSeconds: Math.round(now()), voice }).catch(() => undefined);
    onDone();
  };

  useEffect(() => {
    const pending = pendingDebrief;
    pendingDebrief = null;
    if (!pending) {
      setError('The voice connection was not created. Press Listen again.');
      return;
    }
    const { li, live: started } = pending;
    live.current = li;
    li.connect(
      started.wsUrl,
      started.token,
      started.setup,
      {
        onState: setState,
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
      li.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [turns]);

  return (
    <Section title="Spoken review" sub="say “next”, “repeat”, “slower”, “why”, or “stop”; try the stronger answers out loud">
      <div className="nowbar live">
        <Tag tone={state === 'speaking' ? 'warn' : state === 'listening' ? 'ok' : 'dim'}>{state === 'speaking' ? 'Coach speaking' : STATE_LABEL[state]}</Tag>
        <b>{mmss(elapsed)}</b>
        <span className="meter" aria-label="Microphone level">
          <span style={{ width: `${Math.min(100, Math.round(level * 400))}%` }} />
        </span>
        {error && <Tag tone="bad">{error}</Tag>}
        <span className="controls">
          <Btn kind="danger" onClick={finish}>
            Stop
          </Btn>
        </span>
      </div>
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
    beacon(`/api/sessions/${this.props.sessionId}/log`, { entries: [{ t: 0, event: 'page crashed', detail: `${error.message} | ${String(error.stack ?? '').split('\n').slice(0, 4).join(' | ')}` }] });
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
  const promptUrl = `/api/sessions/${s.id}/review-prompt`;
  const byHand = (
    <p className="hint">
      To grade by hand: open the <a href={promptUrl} target="_blank" rel="noopener">review prompt</a>, paste it into any Claude chat, save the JSON reply as <code>review.json</code>, then run{' '}
      <code>
        curl -X POST localhost:{window.location.port || 80}/api/sessions/{s.id}/review -H 'content-type: application/json' --data @review.json
      </code>
      .
    </p>
  );
  if (s.status === 'live')
    return (
      <Card tone="accent">
        <b>This session never ended.</b>
      </Card>
    );
  if (s.reviewError)
    return (
      <Card tone="bad">
        <b>Grading failed</b>
        <p className="hint">{s.reviewError}</p>
        {opts.grading && (
          <Btn kind="green" onClick={onRetry}>
            Try again
          </Btn>
        )}
        {byHand}
      </Card>
    );
  if (s.grading || opts.grading)
    return (
      <Card tone="accent">
        <b>Claude is grading the call</b>
        <p className="hint">It scores each answer and writes a stronger way to say it. This usually takes a minute or two; the page checks every 10 seconds.</p>
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
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () =>
      get<Session>(`/api/sessions/${id}`).then(
        (x) => {
          if (stop) return;
          setS(x);
          if (x.status === 'ended' && !x.reviewError && (x.grading || opts.grading)) timer = setTimeout(tick, 10_000);
        },
        (e) => setErr(e.message),
      );
    void tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, reload, opts.grading]);

  if (!s) return <div className="loading">{err ?? 'Loading the session…'}</div>;
  const m = s.metrics;
  const wpm = m?.wordsPerMinute && m.wordsPerMinute >= 60 && m.wordsPerMinute <= 260 ? m.wordsPerMinute : null;
  const canTalk = window.isSecureContext && !!navigator.mediaDevices && opts.configured;
  return (
    <>
      <div className="nowbar">
        <Btn kind="ghost" onClick={onBack}>
          ← New round
        </Btn>
        {s.review && !listening && (
          <Btn
            kind="green"
            disabled={!canTalk}
            title={canTalk ? 'A voice coach talks you through this review; you can ask questions and practise the stronger answers' : 'Needs the microphone and GEMINI_API_KEY'}
            onClick={async () => {
              setErr(null);
              const li = new LiveInterview();
              try {
                await li.prepareAudio();
                const live = await post<LiveStart & { voice: string }>(`/api/sessions/${id}/debrief`, opts.voices.some((v) => v.id === coachVoice) ? { voice: coachVoice } : {});
                setUsedVoice(live.voice);
                pendingDebrief = { li, live };
                setListening(true);
              } catch (e) {
                li.stop();
                setErr((e as Error).message);
              }
            }}
          >
            🔊 Listen to the review
          </Btn>
        )}
        {s.review && !listening && (
          <span className="voice-pick">
            <VoiceSelect label="Coach voice" value={coachVoice} onChange={setCoachVoice} opts={opts} />
          </span>
        )}
        <span className="dim">
          {id}
          {s.model ? ` · ${s.model}` : ''} ·{' '}
          <a href={`/api/sessions/${id}`} target="_blank" rel="noopener">
            raw JSON
          </a>
        </span>
      </div>
      {err && (
        <div className="nowbar">
          <Tag tone="bad">Error</Tag> {err}
        </div>
      )}
      {listening && (
        <Debrief
          sessionId={id}
          voice={usedVoice}
          onDone={() => {
            setListening(false);
            setReload((n) => n + 1);
          }}
        />
      )}
      {m && (
        <div className="stats">
          <Stat label="words / min" value={wpm ?? '–'} hint="Calm and clear is roughly 120 to 160" />
          <Stat label="fillers / min" value={m.fillersPerMinute ?? '–'} tone={(m.fillersPerMinute ?? 0) > 4 ? 'warn' : undefined} />
          <Stat label="words / sentence" value={m.avgWordsPerSentence ?? '–'} tone={(m.avgWordsPerSentence ?? 0) > 22 ? 'warn' : undefined} />
          <Stat label="longest answer" value={mmss(m.longestAnswerSeconds)} />
          <Stat label="sir / sorry" value={`${m.sirMadam} / ${m.apologies}`} tone={m.sirMadam + m.apologies ? 'warn' : undefined} />
        </div>
      )}
      {!s.review ? (
        <Pending
          s={s}
          opts={opts}
          onRetry={async () => {
            setErr(null);
            await post(`/api/sessions/${id}/grade`).catch((e) => setErr((e as Error).message));
            setReload((n) => n + 1);
          }}
        />
      ) : (
        <>
          <Section title={`Overall ${s.review.overall}/10`} sub={s.review.reviewer ? `graded by ${s.review.reviewer}` : undefined}>
            <Card>
              <p>{s.review.summary}</p>
              {s.review.next_focus.length > 0 && (
                <>
                  <b>Next time, focus on</b>
                  <ul>
                    {s.review.next_focus.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                </>
              )}
              {s.review.delivery && <p className="dim">{s.review.delivery}</p>}
            </Card>
          </Section>
          {s.debriefs?.length ? (
            <Section title="Spoken debriefs" sub={`${s.debriefs.length} · also in reports/${id}.md`}>
              {[...s.debriefs].reverse().map((d, i) => (
                <details key={d.at} className="call" open={i === 0}>
                  <summary>
                    {ago(d.at)} · {mmss(d.durationSeconds)}
                    {d.voice ? ` · ${d.voice}` : ''}
                  </summary>
                  <Transcript turns={d.transcript} coach tall />
                </details>
              ))}
            </Section>
          ) : null}
          <Section title="Answers">
            {s.review.answers.map((a, i) => (
              <Card key={i} tone={scoreTone(a.score)}>
                <div>
                  <Tag tone={scoreTone(a.score)}>{a.score}/10</Tag> <b>{a.question}</b>
                </div>
                <ul>
                  <li>
                    <b>Technical:</b> {a.technical}
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
        </>
      )}
      <Section title="Tool calls" sub={`${s.toolCalls.length}`}>
        <div className="calls">
          {s.toolCalls.map((c, i) => (
            <CallCard key={i} call={{ key: String(i), name: c.name, args: c.args, at: (Date.parse(c.at) - Date.parse(s.toolCalls[0].at)) / 1000, result: c.result, ms: c.ms, error: c.error }} open={false} />
          ))}
        </div>
      </Section>
      {s.debug?.length ? <ConnectionLog entries={s.debug} /> : null}
      <Section title="Transcript">
        <Transcript turns={s.transcript} tall />
      </Section>
    </>
  );
}
