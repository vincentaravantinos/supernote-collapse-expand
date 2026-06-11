// Single-flight guard shared by the button handler (collapse / expand /
// recollapse) and the motion-driven live redraw. Both mutate the note via
// insert/delete/reloadFile; running two sequences concurrently interleaves their
// writes and corrupts the note. Whoever holds the guard runs; others back off.
let busy = false;

export function acquireBusy(): boolean {
  if (busy) return false;
  busy = true;
  return true;
}

export function releaseBusy(): void {
  busy = false;
}

export function isBusy(): boolean {
  return busy;
}
