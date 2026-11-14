import type { ReactNode } from 'react';
import { parse, type Block } from './md-parse';

/**
 * Markdown for question notes: headings, paragraphs, bullet and numbered lists, block quotes, tables,
 * code blocks (kept unwrapped so text diagrams line up), rules, **bold**, *italic*, `code` and links.
 * Everything becomes React nodes; no HTML from the file reaches the page, and only http(s) links are made.
 *
 * Notes are grouped into one <section> per "## " heading. The study sections the Q&A files use
 * (Remember, Short Answer, Don't Say, Watch...) get a class so each can look like what it is.
 */

/** A short, readable name for a bare URL: the YouTube search words, or the site and page. */
function linkLabel(href: string): string {
  try {
    const u = new URL(href);
    const q = u.searchParams.get('search_query');
    if (/(^|\.)youtube\.com$/.test(u.hostname) && q) return `YouTube: ${q}`;
    const path = u.pathname.replace(/\/$/, '').split('/').filter(Boolean).pop();
    return path ? `${u.hostname.replace(/^www\./, '')} › ${decodeURIComponent(path).replace(/[-_]/g, ' ')}` : u.hostname.replace(/^www\./, '');
  } catch {
    return href;
  }
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  const video = /youtube\.com|youtu\.be/.test(href);
  return (
    <a className={`md-link${video ? ' md-link-video' : ''}`} href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="md-vh"> (opens in a new tab)</span>
    </a>
  );
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s<>]+|\*[^*\s][^*]*\*)/;

export function inline(text: string, key = 'i'): ReactNode[] {
  return text.split(INLINE).map((part, i): ReactNode => {
    const k = `${key}-${i}`;
    if (!part) return null;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <b key={k}>{inline(part.slice(2, -2), k)}</b>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={k}>{part.slice(1, -1)}</code>;
    const md = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (md) return <Link key={k} href={md[2]}>{inline(md[1], k)}</Link>;
    if (/^https?:\/\//.test(part)) {
      const [, href, tail] = part.match(/^(.*?)([.,;:!?)\]]*)$/)!; // sentence punctuation is not part of the URL
      return (
        <span key={k}>
          <Link href={href}>{linkLabel(href)}</Link>
          {tail}
        </span>
      );
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <i key={k}>{inline(part.slice(1, -1), k)}</i>;
    return part;
  });
}

function renderBlock(b: Block, key: string, label: string): ReactNode {
  switch (b.kind) {
    case 'heading':
      return <h5 key={key}>{inline(b.text, key)}</h5>;
    case 'p':
      return <p key={key}>{inline(b.text, key)}</p>;
    case 'hr':
      return <hr key={key} />;
    case 'code':
      return (
        <pre key={key} className="md-code" tabIndex={0}>
          {b.text}
        </pre>
      );
    case 'quote':
      return (
        <blockquote key={key}>
          {b.paras.map((p, j) => (
            <p key={j}>{inline(p, `${key}-${j}`)}</p>
          ))}
        </blockquote>
      );
    case 'list':
      return (
        <ul key={key} className="md-list">
          {b.items.map((it, j) => (
            <li key={j} className={it.marker ? 'md-num' : undefined} data-depth={Math.min(it.depth, 3)} data-marker={it.marker || undefined}>
              {inline(it.text, `${key}-${j}`)}
            </li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div key={key} className="md-table" tabIndex={0} role="region" aria-label={label ? `${label} table` : 'Table'}>
          <table>
            <thead>
              <tr>
                {b.head.map((h, j) => (
                  <th key={j} scope="col">
                    {inline(h, `${key}-h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j}>
                  {b.head.map((h, c) => (
                    <td key={c} data-label={h.replace(/[*`]/g, '')}>
                      {inline(r[c] ?? '', `${key}-${j}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Study sections with their own look; anything else renders as a plain section. */
const KNOWN = new Set(['remember', 'short-answer', 'understand-it', 'words-to-know', 'if-they-push', 'watch', 'dont-say', 'key-phrases', 'turn-it-into-a-story']);

export function Md({ text }: { text: string }) {
  const sections: { title: string; blocks: Block[] }[] = [{ title: '', blocks: [] }];
  for (const b of parse(text)) {
    // The "# " title is the question, which the page already shows above the notes.
    if (b.kind === 'heading' && b.level === 1) continue;
    if (b.kind === 'heading' && b.level === 2) sections.push({ title: b.text, blocks: [] });
    else sections[sections.length - 1].blocks.push(b);
  }
  return (
    <div className="md">
      {sections
        .filter((s) => s.title || s.blocks.length)
        .map((s, i) => {
          const kind = slug(s.title.replace(/[*`]/g, ''));
          return (
            <section key={i} className={`md-sec${KNOWN.has(kind) ? ` md-${kind}` : ''}`}>
              {s.title && <h4>{inline(s.title, `s${i}`)}</h4>}
              {s.blocks.map((b, j) => renderBlock(b, `${i}-${j}`, s.title.replace(/[*`]/g, '')))}
            </section>
          );
        })}
    </div>
  );
}
