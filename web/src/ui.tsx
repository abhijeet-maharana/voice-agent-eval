import { type ReactNode, useState } from 'react';

// Small shared pieces: tags, buttons, cards, sections, stats.

export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function Tag({ tone, children, title }: { tone?: 'ok' | 'bad' | 'warn' | 'dim'; children: ReactNode; title?: string }) {
  return (
    <span className={`tag ${tone || ''}`} title={title}>
      {children}
    </span>
  );
}

/** A button that disables itself while its async handler runs. */
export function Btn({ onClick, children, kind, title, disabled }: { onClick: () => unknown; children: ReactNode; kind?: 'ghost' | 'green' | 'danger'; title?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={`btn ${kind || ''}`}
      title={title}
      disabled={disabled || busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
    </button>
  );
}

export function Card({ children, tone }: { children: ReactNode; tone?: 'bad' | 'warn' | 'ok' | 'accent' }) {
  return <article className={`card ${tone || ''}`}>{children}</article>;
}

export function Section({ title, sub, children, actions }: { title: string; sub?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="section">
      <div className="sec-head">
        <h2>{title}</h2>
        {sub && <span>{sub}</span>}
        {actions && <div className="sec-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

export function Stat({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: 'bad' | 'ok' | 'warn'; hint?: string }) {
  return (
    <div className={`stat ${tone || ''}`} title={hint}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

export const scoreTone = (n: number) => (n >= 7 ? 'ok' : n >= 5 ? 'warn' : 'bad');
