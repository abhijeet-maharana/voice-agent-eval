/**
 * Drawing while the tutor speaks: which parts of a diagram the tutor has named so far. The tutor sends the
 * whole diagram once (show_diagram); the page hides every box and shows each one when its label is heard
 * in the tutor's voice (LiveInterview.onSpoken), and marks the box being talked about now.
 *
 * Pure functions, so the matching is tested without a browser (test/reveal.test.ts).
 */

const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'and', 'or', 'for', 'in', 'on', 'at', 'with', 'is', 'are', 'it', 'its', 'by', 'from', 'into', 'as']);

/** Lowercase words, plurals and simple verb endings trimmed, so "sends requests" matches "Send request". */
export function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(stem);
}

function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ss|sh|ch|x)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/**
 * Where a label was last said in the heard words: the index just past the match, or -1. Every content word
 * of the label must be said within a short window (its length plus 3 words), in any order, so "the app
 * server" and "server for the app" both count for "App server".
 */
export function lastMention(heard: string[], label: string): number {
  const all = words(label);
  const need = all.filter((w) => !STOP.has(w));
  const want = need.length ? need : all;
  if (!want.length) return -1;
  const span = want.length + 3;
  for (let end = heard.length; end > 0; end--) {
    if (!want.includes(heard[end - 1])) continue;
    const window = heard.slice(Math.max(0, end - span), end);
    if (want.every((w) => window.includes(w))) return end;
  }
  return -1;
}

export interface Piece {
  /** What the tutor would say for it: a box label, an arrow label, a message. */
  label: string;
  kind: 'node' | 'edge' | 'message';
  /** Edges: the node keys at each end. */
  from?: string;
  to?: string;
  /** Nodes: the key edges refer to. Messages: their order from the top. */
  key?: string;
  order?: number;
}

/**
 * Which pieces show, and which one is "now" (named in the last `recent` words). A node shows once named; an
 * edge once both ends show or its own label is named (which shows its ends too); a message once it or a
 * later one is named, so a sequence fills top down.
 */
export function revealState(pieces: Piece[], heardText: string, recent = 25): { shown: Set<number>; now: number | null } {
  const heard = words(heardText);
  const at = pieces.map((p) => (p.label.trim() ? lastMention(heard, p.label) : -1));
  const shown = new Set<number>();
  const nodeShown = new Set<string>();
  pieces.forEach((p, i) => {
    if (p.kind === 'node' && at[i] >= 0) {
      shown.add(i);
      if (p.key) nodeShown.add(p.key);
    }
  });
  pieces.forEach((p, i) => {
    if (p.kind === 'edge' && at[i] >= 0) for (const k of [p.from, p.to]) if (k) nodeShown.add(k);
  });
  pieces.forEach((p, i) => {
    if (p.kind === 'node' && p.key && nodeShown.has(p.key)) shown.add(i);
    if (p.kind === 'edge' && (at[i] >= 0 || (p.from && p.to && nodeShown.has(p.from) && nodeShown.has(p.to)))) shown.add(i);
  });
  const lastMsg = Math.max(-1, ...pieces.map((p, i) => (p.kind === 'message' && at[i] >= 0 ? (p.order ?? 0) : -1)));
  pieces.forEach((p, i) => {
    if (p.kind === 'message' && (p.order ?? 0) <= lastMsg) shown.add(i);
  });
  let now: number | null = null;
  pieces.forEach((p, i) => {
    if (p.kind !== 'edge' && at[i] >= 0 && at[i] >= heard.length - recent && (now === null || at[i] > at[now])) now = i;
  });
  return { shown, now };
}
