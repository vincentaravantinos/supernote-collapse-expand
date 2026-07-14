import { PluginManager } from 'sn-plugin-lib';
import { LOG } from '../constants';

// Single-flight guard shared by the button handler (collapse / expand /
// recollapse) and the motion-driven live redraw. Both mutate the note via
// insert/delete/reloadFile; running two sequences concurrently interleaves their
// writes and corrupts the note. Whoever holds the guard runs; others back off.
//
// Self-healing: a crash mid-operation never runs the `finally` that releases the
// guard, and handleMainAction's setTimeout watchdog doesn't fire while the host
// is dead/idle (JS timers need a pumped loop). So track WHEN the guard was
// acquired and let a sufficiently stale guard be reacquired regardless — this
// doesn't depend on any timer firing.
const STALE_MS = 90000; // longer than any legitimate operation

let busySince: number | null = null;

export function acquireBusy(): boolean {
  if (busySince !== null) {
    if (Date.now() - busySince < STALE_MS) return false;
    console.error(`${LOG} busy guard stale (held >${STALE_MS / 1000}s) — self-healing`);
  }
  busySince = Date.now();
  return true;
}

export function releaseBusy(): void {
  busySince = null;
}

export function isBusy(): boolean {
  return busySince !== null;
}

// User-triggered escape hatch for a stuck "working" card (see BUGS/B-008.md —
// an operation whose foreground app switched away mid-flight can leave the
// view stuck with nothing left running to close it). Best-effort force-close
// + unconditional release; does NOT (and can't) stop whatever's still stuck
// mid-await — deliberately out of scope, see DIAGNOSTIC.md.
export async function cancelStuckOperation(): Promise<void> {
  try {
    const res: any = await PluginManager.closePluginView();
    if (!res?.success) console.error(`${LOG} cancel: closePluginView res=${JSON.stringify(res)}`);
  } catch (e) {
    console.error(`${LOG} cancel: closePluginView failed: ${e}`);
  }
  releaseBusy();
}
