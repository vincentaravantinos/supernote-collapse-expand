// Bridges the imperative showPluginView() calls (scattered across index.ts /
// iconTapToggle.ts / iconMoveRedraw.ts) with App.tsx's React tree, which stays
// mounted for the plugin's whole lifetime — only the native view's visibility
// toggles per show/close, so a plain useEffect-on-mount can't detect "shown
// again." A generation counter lets App.tsx notice each new show via polling
// and restart its cancel-button timer accordingly.
let generation = 0;

export function notifyShown(): void {
  generation++;
}

export function getGeneration(): number {
  return generation;
}
