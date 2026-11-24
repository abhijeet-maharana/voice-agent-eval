/**
 * A question file's saved diagram: a `## Diagram` section with a bold title line and a ```mermaid block,
 * or a "No diagram:" line when a picture would not help. Pure text functions, so they are tested without
 * files (test/diagrams.test.ts).
 *
 *     ## Diagram
 *
 *     **Request through a load balancer**
 *
 *     ```mermaid
 *     flowchart LR
 *       A["Client"] --> B["Load balancer"] --> C["App server"]
 *     ```
 *
 * The section goes right after the short answer (or at the end of a file without one), so the picture sits
 * near the top when the file is read anywhere else.
 */

export interface SavedDiagram {
  title: string;
  mermaid: string;
}

/** What a file holds: a diagram, a "not needed" mark with its reason, or nothing yet. */
export type DiagramState = { diagram: SavedDiagram } | { none: string } | null;

/** The most Mermaid code one diagram may hold (a small teaching diagram is a few hundred characters). */
export const MAX_DIAGRAM = 3000;

const HEADING = /^##\s+Diagram\s*$/i;
const ANY_HEADING = /^#{1,2}\s/;
const NONE = /^No diagram:\s*(.*)$/i;

/** Where the section is, as line indexes [start, end), or null. It runs to the next `#` or `##` heading. */
function locate(lines: string[]): [number, number] | null {
  const start = lines.findIndex((l) => HEADING.test(l));
  if (start < 0) return null;
  let end = start + 1;
  let inCode = false;
  for (; end < lines.length; end++) {
    if (lines[end].trimStart().startsWith('```')) inCode = !inCode;
    else if (!inCode && ANY_HEADING.test(lines[end])) break;
  }
  return [start, end];
}

export function readDiagram(text: string): DiagramState {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const at = locate(lines);
  if (!at) return null;
  const body = lines.slice(at[0] + 1, at[1]);
  const none = body.map((l) => l.trim().match(NONE)).find(Boolean);
  if (none) return { none: none[1].trim() || 'Not needed for this question.' };
  const open = body.findIndex((l) => /^```mermaid\s*$/i.test(l.trim()));
  if (open < 0) return null;
  const close = body.findIndex((l, i) => i > open && l.trim().startsWith('```'));
  const mermaid = body.slice(open + 1, close < 0 ? undefined : close).join('\n').trim();
  if (!mermaid) return null;
  const title = body.slice(0, open).map((l) => l.trim()).find(Boolean)?.replace(/^\*\*(.*)\*\*$/, '$1').trim() ?? '';
  return { diagram: { title, mermaid } };
}

/** The file without its diagram section: for notes, where the diagram shows on its own. */
export function withoutDiagram(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const at = locate(lines);
  if (!at) return text;
  return [...lines.slice(0, at[0]), ...lines.slice(at[1])].join('\n').replace(/\n{3,}/g, '\n\n');
}

/** The section's lines for a diagram or a "not needed" mark. */
function sectionLines(value: { diagram: SavedDiagram } | { none: string }): string[] {
  if ('none' in value) return ['## Diagram', '', `No diagram: ${value.none.replace(/\s+/g, ' ').trim()}`];
  const { title, mermaid } = value.diagram;
  return ['## Diagram', '', ...(title ? [`**${title}**`, ''] : []), '```mermaid', mermaid.trim(), '```'];
}

/**
 * The file with its diagram section replaced, added or (null) removed. A new section goes after the short
 * answer section, or at the end when the file has none.
 */
export function setDiagram(text: string, value: { diagram: SavedDiagram } | { none: string } | null): string {
  const lines = withoutDiagram(text).replace(/\s+$/, '').split('\n');
  if (!value) return `${lines.join('\n')}\n`;
  const short = lines.findIndex((l) => /^##+ .*short answer/i.test(l));
  let at = lines.length;
  if (short >= 0) {
    const next = lines.findIndex((l, i) => i > short && ANY_HEADING.test(l));
    if (next >= 0) at = next;
  }
  const before = lines.slice(0, at);
  while (before.length && !before[before.length - 1].trim()) before.pop();
  const after = lines.slice(at);
  return `${[...before, '', ...sectionLines(value), ...(after.length ? ['', ...after] : [])].join('\n')}\n`;
}

/** Mermaid types a teaching diagram may use: the ones the page can draw part by part. */
const TYPES = /^(flowchart|graph)\s+(LR|RL|TD|TB|BT)\b|^sequenceDiagram\b/;

/** Checks a diagram before it is saved or shown. Returns the cleaned title and code, or throws a plain message. */
export function checkDiagram(title: unknown, mermaid: unknown): SavedDiagram {
  const code = String(mermaid ?? '').replace(/\r\n?/g, '\n').trim();
  const name = String(title ?? '').replace(/[*\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!code) throw new Error('The diagram is empty.');
  if (code.length > MAX_DIAGRAM) throw new Error(`The diagram is too big (${code.length} characters, at most ${MAX_DIAGRAM}). Draw fewer boxes.`);
  const first = code.split('\n').find((l) => l.trim() && !l.trim().startsWith('%%'))?.trim() ?? '';
  if (!TYPES.test(first)) throw new Error('Use "flowchart LR", "flowchart TD" or "sequenceDiagram".');
  if (code.includes('```')) throw new Error('The diagram may not hold a code fence.');
  if (/%%\{|^\s*click\s/im.test(code)) throw new Error('No init directives or click links in a diagram.');
  return { title: name, mermaid: code };
}
