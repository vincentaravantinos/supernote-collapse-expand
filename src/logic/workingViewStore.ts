// Bridges the imperative showPluginView() calls (scattered across the entry
// points) with App.tsx's React tree, which stays mounted for the plugin's whole
// lifetime — only the native view's visibility toggles per show/close, so a
// plain useEffect-on-mount can't detect "shown again." A generation counter
// lets App.tsx notice each new show via polling and restart its cancel-button
// timer accordingly.
let generation = 0;

export function notifyShown(): void {
  generation++;
}

export function getGeneration(): number {
  return generation;
}

// The plugin's own choice dialog, rendered in the same view as the "working"
// card (the SDK's native dialog can't be titled). Listeners push the state
// into React immediately: the host only runs JS when a native event arrives,
// so it must be set before the view is shown, not discovered by polling.
export interface DialogButton { id: string; label: string }
export interface DialogState { message: string; buttons: DialogButton[] }

let dialog: DialogState | null = null;
let resolveDialog: ((id: string) => void) | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getDialog(): DialogState | null {
  return dialog;
}

export function askInView(message: string, buttons: DialogButton[]): Promise<string> {
  return new Promise((resolve) => {
    dialog = { message, buttons };
    resolveDialog = resolve;
    notify();
  });
}

export function answerDialog(id: string): void {
  const resolve = resolveDialog;
  dialog = null;
  resolveDialog = null;
  notify();
  resolve?.(id);
}
