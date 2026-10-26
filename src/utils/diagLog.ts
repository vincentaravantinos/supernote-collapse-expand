// [B-032] TEMP remote diagnostics: an in-memory log the user can open from
// the sidebar and photograph, since beta testers can't send us logcat.
const MAX_LINES = 300;
const lines: string[] = [];
const listeners = new Set<() => void>();

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function diag(msg: string): void {
  lines.push(`${stamp()} ${msg}`);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  for (const l of listeners) l();
}

export function getDiagLines(): string[] {
  return lines;
}

export function clearDiag(): void {
  lines.length = 0;
  for (const l of listeners) l();
}

export function subscribeDiag(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Mirror every console.error (the plugin's existing error reporting) into the log.
let hooked = false;
export function hookConsoleErrors(): void {
  if (hooked) return;
  hooked = true;
  const orig = console.error.bind(console);
  console.error = (...args: any[]) => {
    try {
      diag('ERR ' + args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ').replace('[CollapseExpand] ', ''));
    } catch {
      // never let logging break the caller
    }
    orig(...args);
  };
}

export function safeJson(v: any, max = 300): string {
  let s: string;
  try {
    s = v instanceof Error ? `${v.name}: ${v.message}` : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s === undefined) s = String(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
}
