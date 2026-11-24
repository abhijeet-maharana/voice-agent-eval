import { useEffect, useRef, useState } from 'react';
import { get, post } from './api';
import { Diagram } from './diagram';
import { Btn, ConfirmButton } from './ui';

/**
 * A bank item's saved diagram, with what you can do to it: test yourself on it (labels blanked), have Claude
 * revise it ("add a cache box"), remove it, or add one when there is none. Claude's drawing is a draft until
 * you press Save, which writes it into the item's file (src/diagram-text.ts). A draft Mermaid can't draw is
 * sent back to Claude once to fix.
 */

type Saved = { title: string; mermaid: string };
type State = { diagram: Saved } | { none: string } | null;
type Draft = { needed: boolean; reason: string; title: string; mermaid: string };

export function DiagramPanel({ id, onSaved }: { id: string; onSaved?: (kind: 'saved' | 'none' | null) => void }) {
  const [state, setState] = useState<State | undefined>(undefined);
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [asking, setAsking] = useState(false);
  const [ask, setAsk] = useState('');
  const [quiz, setQuiz] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** A draft is sent back to fix at most once, so a stubborn error can't loop. */
  const fixed = useRef(false);

  useEffect(() => {
    get<{ state: State; drawing: boolean }>(`api/question-diagram?id=${encodeURIComponent(id)}`).then(
      (r) => {
        setState(r.state);
        setDrawing(r.drawing);
      },
      (e) => setErr(`Could not load the diagram: ${(e as Error).message}`),
    );
  }, [id]);

  const saved = state && 'diagram' in state ? state.diagram : null;

  const requestDraft = async (body: Record<string, unknown>, label: string) => {
    setErr(null);
    setBusy(label);
    try {
      const d = await post<Draft>('api/question-diagram/draft', { id, ...body });
      fixed.current = !!body.error;
      setDraft(d);
      setAsking(false);
      setAsk('');
      setQuiz(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /** Revise the draft when there is one, else the saved diagram, else draw a new one. */
  const revise = () => {
    const base = draft?.needed ? draft : saved;
    void requestDraft({ instruction: ask, ...(base ? { current: { title: base.title, mermaid: base.mermaid } } : {}), force: true }, 'Drawing…');
  };

  const save = async (body: Record<string, unknown>) => {
    setErr(null);
    try {
      const r = await post<{ state: State }>('api/question-diagram/save', { id, ...body });
      setState(r.state);
      setDraft(null);
      onSaved?.(r.state ? ('diagram' in r.state ? 'saved' : 'none') : null);
    } catch (e) {
      setErr(`Could not save: ${(e as Error).message}`);
    }
  };

  const askBox = (
    <form
      className="dg-ask"
      onSubmit={(e) => {
        e.preventDefault();
        if (ask.trim()) revise();
      }}
    >
      <input
        className="input"
        autoFocus
        value={ask}
        onChange={(e) => setAsk(e.target.value)}
        placeholder={'What to change, e.g. "add a cache box" or "make it a sequence diagram"'}
        aria-label="What to change in the diagram"
        maxLength={500}
      />
      <button type="submit" className="btn" disabled={!ask.trim() || !!busy}>
        {busy ?? 'Revise'}
      </button>
      <button type="button" className="btn ghost" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </form>
  );

  if (state === undefined) return <p className="hint">{err ?? 'Loading the diagram…'}</p>;
  const noKey = !drawing ? 'Drawing needs ANTHROPIC_API_KEY on the server.' : undefined;

  return (
    <div className="dg-panel">
      {draft ? (
        <div className="dg-draft">
          {draft.needed ? (
            <>
              <p className="dg-label">Draft, not saved yet</p>
              <Diagram
                key={draft.mermaid}
                code={draft.mermaid}
                title={draft.title}
                onError={(message) => {
                  if (fixed.current) return setErr('Claude could not fix this drawing. Ask for a change, or discard it.');
                  void requestDraft({ current: { title: draft.title, mermaid: draft.mermaid }, error: message }, 'Fixing…');
                }}
              />
              {asking ? (
                askBox
              ) : (
                <div className="dg-actions">
                  <Btn kind="green" onClick={() => save({ title: draft.title, mermaid: draft.mermaid })} busyLabel="Saving…">
                    Save
                  </Btn>
                  <button type="button" className="btn ghost" disabled={!!busy} onClick={() => setAsking(true)}>
                    Change it…
                  </button>
                  <button type="button" className="btn ghost" disabled={!!busy} onClick={() => setDraft(null)}>
                    Discard
                  </button>
                  {busy && <span className="dim">{busy}</span>}
                </div>
              )}
            </>
          ) : (
            <>
              <p className="dg-label">Claude thinks a picture won't help here</p>
              <p className="hint">{draft.reason}</p>
              <div className="dg-actions">
                <button type="button" className="btn" disabled={!!busy} onClick={() => void requestDraft({ force: true }, 'Drawing…')}>
                  {busy ?? 'Draw one anyway'}
                </button>
                <Btn kind="ghost" onClick={() => save({ none: draft.reason })}>
                  Mark as not needed
                </Btn>
                <button type="button" className="btn ghost" onClick={() => setDraft(null)}>
                  Discard
                </button>
              </div>
            </>
          )}
        </div>
      ) : saved ? (
        <>
          <Diagram key={saved.mermaid} code={saved.mermaid} title={saved.title} quiz={quiz} />
          {asking ? (
            askBox
          ) : (
            <div className="dg-actions">
              <button type="button" className="btn ghost" onClick={() => setQuiz((q) => !q)} aria-pressed={quiz}>
                {quiz ? 'Show labels' : 'Test me'}
              </button>
              <button type="button" className="btn ghost" disabled={!!noKey || !!busy} title={noKey} onClick={() => setAsking(true)}>
                Revise…
              </button>
              <ConfirmButton kind="ghost" onConfirm={() => save({ remove: true })} confirmLabel="Press again to remove">
                Remove
              </ConfirmButton>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="hint">{state && 'none' in state ? `No diagram: ${state.none}` : 'No diagram yet.'}</p>
          {asking ? (
            askBox
          ) : (
            <div className="dg-actions">
              <button type="button" className="btn ghost" disabled={!!noKey || !!busy} title={noKey} onClick={() => void requestDraft(state ? { force: true } : {}, 'Drawing…')}>
                {busy ?? (state ? 'Draw one anyway' : 'Add diagram')}
              </button>
              <button type="button" className="linkish" disabled={!!noKey || !!busy} onClick={() => setAsking(true)}>
                Describe what to draw
              </button>
            </div>
          )}
        </>
      )}
      {noKey && !draft && <p className="hint">{noKey}</p>}
      {err && <p className="hint bad-ink" role="alert">{err}</p>}
    </div>
  );
}
