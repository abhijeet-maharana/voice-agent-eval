/** Parses question notes markdown into blocks; md.tsx turns them into React nodes. */

export type Item = { text: string; depth: number; marker: string };
export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'quote'; paras: string[] }
  | { kind: 'list'; items: Item[] }
  | { kind: 'code'; text: string; lang?: string }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'hr' };

const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

export function parse(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
    } else if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3).trim().toLowerCase();
      const code: string[] = [];
      while (++i < lines.length && !lines[i].trimStart().startsWith('```')) code.push(lines[i]);
      i++;
      out.push({ kind: 'code', text: code.join('\n'), ...(lang ? { lang } : {}) });
    } else if (HEADING.test(line)) {
      const [, hashes, body] = line.match(HEADING)!;
      out.push({ kind: 'heading', level: hashes.length, text: body.trim() });
      i++;
    } else if (RULE.test(line)) {
      out.push({ kind: 'hr' });
      i++;
    } else if (line.trimStart().startsWith('>')) {
      const paras: string[] = [];
      let cur: string[] = [];
      for (; i < lines.length && lines[i].trimStart().startsWith('>'); i++) {
        const body = lines[i].trimStart().replace(/^>\s?/, '');
        if (body.trim()) cur.push(body.trim());
        else if (cur.length) (paras.push(cur.join(' ')), (cur = []));
      }
      if (cur.length) paras.push(cur.join(' '));
      out.push({ kind: 'quote', paras });
    } else if (line.trimStart().startsWith('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].trimStart().startsWith('|'); i++) rows.push(cells(lines[i]));
      out.push({ kind: 'table', head, rows });
    } else if (LIST.test(line)) {
      const items: Item[] = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST);
        if (m) {
          items.push({ depth: Math.floor(m[1].replace(/\t/g, '  ').length / 2), marker: /\d/.test(m[2]) ? m[2] : '', text: m[3] });
        } else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
          items[items.length - 1].text += ` ${lines[i].trim()}`; // a wrapped continuation of the last item
        } else break;
        i++;
      }
      out.push({ kind: 'list', items });
    } else {
      const para: string[] = [line.trim()]; // always take this line, or a stray "| ..." line would never advance
      for (i++; i < lines.length; i++) {
        const l = lines[i];
        if (!l.trim() || HEADING.test(l) || LIST.test(l) || RULE.test(l) || /^\s*(```|>|\|)/.test(l)) break;
        para.push(l.trim());
      }
      out.push({ kind: 'p', text: para.join(' ') });
    }
  }
  return out;
}
