import { LOG } from '../constants';
import { closeBusyView } from '../utils/busyView';

// Single-flight guard shared by every note-mutating entry point (see
// runExclusive). All of them mutate the note; running two sequences
// concurrently interleaves their writes and corrupts the note. Whoever holds the guard runs; others back off.
//
// Self-healing: a crash mid-operation never runs the `finally` that releases the
// guard, and runExclusive's setTimeout watchdog doesn't fire while the host
// is dead/idle (JS timers need a pumped loop). So track WHEN the guard was
// acquired and let a sufficiently stale guard be reacquired regardless — this
// doesn't depend on any timer firing.
const STALE_MS = 90000; // longer than any legitimate operation

let busySince: number | null = null;
// While the holder is waiting on the user (a dialog), however long that takes
// is not a sign of a crash.
let awaitingUser = false;

export function acquireBusy(): boolean {
  if (busySince !== null) {
    if (awaitingUser || Date.now() - busySince < STALE_MS) return false;
    console.error(`${LOG} busy guard stale (held >${STALE_MS / 1000}s) — self-healing`);
  }
  busySince = Date.now();
  return true;
}

export function releaseBusy(): void {
  busySince = null;
  awaitingUser = false;
}

export function setAwaitingUser(waiting: boolean): void {
  awaitingUser = waiting;
  if (!waiting && busySince !== null) busySince = Date.now(); // the wait doesn't count toward staleness
}

// User-triggered escape hatch for a stuck "working" card: an operation whose
// foreground app switched away mid-flight can leave the view stuck with
// nothing left running to close it. Best-effort force-close + unconditional
// release; does NOT (and can't) stop whatever's still stuck mid-await — JS
// has no way to cancel a pending await, only to stop waiting on it.
export async function cancelStuckOperation(): Promise<void> {
  await closeBusyView('cancel');
  releaseBusy();
}
