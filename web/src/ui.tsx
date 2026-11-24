import { type ReactNode, useEffect, useState } from 'react';

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

/** A date you can place, then how long ago: "12 Nov, 19:30 · 2d ago". */
export function when(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return `${d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${ago(iso)}`;
}

/** A speaker drawn as a line icon (decorative: the button text says what it does). */
export function SpeakerIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5 6 9H3v6h3l5 4V5z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  );
}

export function Tag({ tone, children, title }: { tone?: 'ok' | 'bad' | 'warn' | 'dim'; children: ReactNode; title?: string }) {
  return (
    <span className={`tag ${tone || ''}`} title={title}>
      {children}
    </span>
  );
}

/** A button that disables itself while its async handler runs, showing `busyLabel` meanwhile if given. */
export function Btn({ onClick, children, kind, title, disabled, busyLabel }: { onClick: () => unknown; children: ReactNode; kind?: 'ghost' | 'green' | 'danger'; title?: string; disabled?: boolean; busyLabel?: ReactNode }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={`btn ${kind || ''}`}
      title={title}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
}

/**
 * For actions that end something (End interview): the first press arms it ("Press again to end"), a second
 * press within 4 seconds does it. No dialog, so a live call keeps running while you decide.
 */
export function ConfirmButton({ onConfirm, children, confirmLabel, disabled, kind = 'danger' }: { onConfirm: () => unknown; children: ReactNode; confirmLabel: ReactNode; disabled?: boolean; kind?: 'danger' | 'ghost' }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={`btn ${kind} ${armed ? 'armed' : ''}`}
      disabled={disabled}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        void onConfirm();
      }}
    >
      <span aria-live="polite">{armed ? confirmLabel : children}</span>
    </button>
  );
}

export function Card({ children, tone, role }: { children: ReactNode; tone?: 'bad' | 'warn' | 'ok' | 'accent'; role?: 'alert' | 'status' }) {
  return (
    <article className={`card ${tone || ''}`} role={role}>
      {children}
    </article>
  );
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

/** One measured number with its label and, under it, what good looks like (visible: tooltips don't exist on a phone). */
export function Stat({ label, value, tone, note }: { label: string; value: ReactNode; tone?: 'bad' | 'ok' | 'warn'; note?: string }) {
  return (
    <div className={`stat ${tone || ''}`}>
      <b>{value}</b>
      <span>{label}</span>
      {note && <small>{note}</small>}
    </div>
  );
}

export const scoreTone = (n: number) => (n >= 7 ? 'ok' : n >= 5 ? 'warn' : 'bad');
