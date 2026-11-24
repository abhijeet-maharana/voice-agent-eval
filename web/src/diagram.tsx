import { type MouseEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { revealState, type Piece } from './reveal';

/**
 * A Mermaid diagram: the tutor's show_diagram calls, and ```mermaid blocks in question notes. Mermaid is big
 * (about 1 MB), so it loads only the first time a diagram shows. securityLevel "strict" sanitises labels, so
 * the SVG is safe to put in the page. A diagram that does not parse shows its code instead, so the lesson
 * goes on.
 *
 * With `reveal` it draws while the tutor speaks: every box starts hidden and shows when its label is heard
 * (reveal.ts), and the box being talked about is outlined. `reveal.all` shows everything.
 *
 * With `quiz` (guess the blanks) every label is blanked out: name each box out loud, then tap it to check.
 */

type MermaidApi = typeof import('mermaid').default;
let loading: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  loading ??= import('mermaid').then(({ default: mermaid }) => {
    const light = window.matchMedia?.('(prefers-color-scheme: light)').matches;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: light ? 'default' : 'dark', suppressErrorRendering: true, fontFamily: 'inherit' });
    return mermaid;
  });
  return loading;
}

/** What a live model sends is not always clean: code fences around it, or "\n" typed out instead of new lines. */
export function cleanMermaid(code: string): string {
  let c = code.trim().replace(/^```(?:mermaid)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  if (!c.includes('\n') && c.includes('\\n')) c = c.replace(/\\n/g, '\n');
  return c.trim();
}

/** The parts of a rendered Mermaid SVG that can be revealed, each with the elements that draw it. */
function piecesOf(svg: SVGSVGElement): { piece: Piece; els: Element[] }[] {
  const out: { piece: Piece; els: Element[] }[] = [];
  const text = (e: Element | null | undefined) => (e?.textContent ?? '').replace(/["']/g, '').trim();
  // Flowcharts: boxes are g.node (id "<svg id>-flowchart-<node id>-<n>"), arrows path.flowchart-link (data-id "L_<from>_<to>_<n>").
  const keys: string[] = [];
  svg.querySelectorAll('g.node').forEach((g) => {
    const key = g.id.match(/-flowchart-(.+)-\d+$/)?.[1];
    if (!key) return;
    keys.push(key);
    out.push({ piece: { kind: 'node', key, label: text(g) }, els: [g] });
  });
  svg.querySelectorAll('path.flowchart-link').forEach((path) => {
    const dataId = path.getAttribute('data-id') ?? '';
    const body = dataId.replace(/^L_/, '').replace(/_\d+$/, '');
    // Node ids may hold underscores: take the split where both halves are real node ids.
    const from = keys.find((k) => body.startsWith(`${k}_`) && keys.includes(body.slice(k.length + 1)));
    const label = svg.querySelector(`g.label[data-id="${CSS.escape(dataId)}"]`);
    const els: Element[] = [path];
    const box = label?.closest('g.edgeLabel');
    if (box) els.push(box);
    out.push({ piece: { kind: 'edge', from, to: from ? body.slice(from.length + 1) : undefined, label: text(label) }, els });
  });
  // Sequence diagrams: the people stay; each message (its text and its arrow) appears in order.
  const lines = [...svg.querySelectorAll('line.messageLine0, line.messageLine1')];
  svg.querySelectorAll('text.messageText').forEach((t, order) => {
    out.push({ piece: { kind: 'message', order, label: text(t) }, els: [t, ...(lines[order] ? [lines[order]] : [])] });
  });
  return out;
}

/** Parts with words to guess: boxes and messages, and arrows that carry a label. */
const guessable = (p: Piece) => p.kind !== 'edge' || !!p.label;

/** The element whose words are blanked in a quiz: the box, the arrow's label, the message text. */
const blankEl = (p: { piece: Piece; els: Element[] }) => (p.piece.kind === 'edge' ? p.els[1] : p.els[0]);

export function Diagram({ code, title, reveal, quiz, onProgress, onShowAll, onError }: {
  code: string;
  title?: string;
  /** Draw while speaking: `heard` is what the tutor has said since the diagram came up. */
  reveal?: { heard: string; all: boolean };
  /** How many parts show, after each change (the page uses it to show everything when the walk through stops). */
  onProgress?: (shown: number, total: number) => void;
  onShowAll?: () => void;
  /** Guess the blanks: labels hidden until tapped. */
  quiz?: boolean;
  /** Mermaid could not draw the code (the message says why), e.g. to have it fixed. */
  onError?: (message: string) => void;
}) {
  const id = `mmd-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  /** All parts (for the page's fallback) and boxes or messages only (for the caption; arrows follow their boxes). */
  const [progress, setProgress] = useState<{ shown: number; total: number; boxes: number; boxTotal: number } | null>(null);
  /** Quiz: parts tapped open, and how many there are to guess. */
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());
  const [toGuess, setToGuess] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const parts = useRef<{ piece: Piece; els: Element[] }[]>([]);
  const clean = cleanMermaid(code);
  const progressive = !!reveal && !reveal.all;
  useEffect(() => {
    let stop = false;
    setSvg(null);
    setFailed(false);
    loadMermaid()
      .then((mermaid) => mermaid.render(id, clean))
      .then(
        (r) => !stop && setSvg(r.svg),
        (e) => {
          if (stop) return;
          setFailed(true);
          onError?.(String((e as Error)?.message ?? e).slice(0, 500));
        },
      );
    return () => {
      stop = true;
    };
  }, [clean, id]);
  // Find the parts once per drawing, then show and hide them as the words come in.
  useLayoutEffect(() => {
    const el = box.current?.querySelector('svg');
    parts.current = el ? piecesOf(el) : [];
    parts.current.forEach((p, i) => p.els.forEach((e) => e.setAttribute('data-dg', String(i))));
    setToGuess(parts.current.filter((p) => guessable(p.piece) && blankEl(p)).length);
    setRevealed(new Set());
  }, [svg]);
  useEffect(() => setRevealed(new Set()), [quiz]);
  // Quiz: blank every label not tapped open yet.
  useLayoutEffect(() => {
    parts.current.forEach((p, i) => blankEl(p)?.classList.toggle('dg-blank', !!quiz && guessable(p.piece) && !revealed.has(i)));
  }, [svg, quiz, revealed]);
  useLayoutEffect(() => {
    const list = parts.current;
    if (!svg) return;
    // The box being talked about stays outlined after everything shows.
    const state = reveal && list.length ? revealState(list.map((p) => p.piece), reveal.heard) : null;
    const shown = progressive && state ? state.shown : new Set(list.map((_, i) => i));
    const now = state?.now ?? null;
    list.forEach((p, i) =>
      p.els.forEach((e) => {
        e.classList.toggle('dg-hide', !shown.has(i));
        e.classList.toggle('dg-now', i === now);
      }),
    );
    const boxes = list.map((p, i) => ({ edge: p.piece.kind === 'edge', on: shown.has(i) })).filter((b) => !b.edge);
    const next = { shown: shown.size, total: list.length, boxes: boxes.filter((b) => b.on).length, boxTotal: boxes.length };
    setProgress((old) => (old && JSON.stringify(old) === JSON.stringify(next) ? old : next));
  }, [svg, progressive, reveal?.heard]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (progress) onProgress?.(progress.shown, progress.total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress]);
  const waiting = progressive && progress && progress.total > 0 && progress.shown < progress.total;
  const checked = parts.current.filter((p, i) => revealed.has(i) && guessable(p.piece) && blankEl(p)).length;
  const tap = (e: MouseEvent) => {
    if (!quiz) return;
    const i = Number((e.target as Element).closest('[data-dg]')?.getAttribute('data-dg'));
    if (Number.isInteger(i) && parts.current[i] && guessable(parts.current[i].piece)) setRevealed((r) => new Set(r).add(i));
  };
  return (
    <figure className={`diagram ${quiz ? 'quiz' : ''}`}>
      {(title || waiting || (quiz && svg)) && (
        <figcaption>
          {title}
          {quiz && svg && toGuess > 0 && (
            <span className="diagram-wait" aria-live="polite">
              {checked < toGuess ? `Name each blank out loud, then tap it to check · ${checked} of ${toGuess}` : 'All checked'}
              {checked < toGuess && (
                <>
                  {' · '}
                  <button type="button" className="linkish" onClick={() => setRevealed(new Set(parts.current.map((_, i) => i)))}>
                    Reveal all
                  </button>
                </>
              )}
            </span>
          )}
          {waiting && (
            <span className="diagram-wait">
              {progress!.boxes ? `${progress!.boxes} of ${progress!.boxTotal} drawn` : 'Draws as the tutor explains'}
              {onShowAll && (
                <>
                  {' · '}
                  <button type="button" className="linkish" onClick={onShowAll}>
                    Show all
                  </button>
                </>
              )}
            </span>
          )}
        </figcaption>
      )}
      {failed ? (
        <>
          <p className="hint">Could not draw this diagram; here is its code.</p>
          <pre className="md-code" tabIndex={0}>
            {clean}
          </pre>
        </>
      ) : svg ? (
        <div ref={box} className="diagram-svg" role="img" aria-label={title ?? 'Diagram'} onClick={tap} dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <p className="hint">Drawing…</p>
      )}
    </figure>
  );
}
