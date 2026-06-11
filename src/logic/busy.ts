// Single-flight guard shared by the plugin-button handler (collapse / expand /
// recollapse) and the motion-driven live box redraw. Both mutate the note via
// insert/delete/reloadFile; running two such sequences concurrently interleaves
// their writes and corrupts the note (the cached/real desync class). Whoever
// holds the guard runs; everyone else backs off until it's released.
let busy = false;

// Try to take the guard. Returns true if acquired (caller must releaseBusy when
// done), false if something else is already running.
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
