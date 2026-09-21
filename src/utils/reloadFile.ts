import { PluginCommAPI } from 'sn-plugin-lib';
import { LOG } from '../constants';

// B-017: PluginCommAPI.reloadFile() can hang indefinitely on this SDK build
// (see BUGS/B-017.md). It's not needed to surface a write for the NEXT
// user-triggered action (real-world time has passed by then), but B-018
// showed it IS needed before a same-turn verification read right after a
// write — without it, getElements() can return a stale pre-write snapshot
// even a beat later, producing a false "the write didn't land" verdict.
// Use this before any such read; never call reloadFile() directly.
const RELOAD_TIMEOUT_MS = 5000;

export async function reloadFileWithTimeout(): Promise<void> {
  await Promise.race([
    PluginCommAPI.reloadFile(),
    new Promise<void>((resolve) => setTimeout(() => {
      console.error(`${LOG} reloadFile() timed out after ${RELOAD_TIMEOUT_MS}ms — proceeding without it`);
      resolve();
    }, RELOAD_TIMEOUT_MS)),
  ]);
}
