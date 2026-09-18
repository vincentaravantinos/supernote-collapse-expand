import { PluginManager } from 'sn-plugin-lib';
import { LOG, dlog } from '../constants';
import { notifyShown } from '../logic/workingViewStore';

// Show the plugin's own "working" overlay (see App.tsx) — the SDK has no
// non-blocking busy primitive, every native dialog is a blocking modal.
// Best-effort: a failure here degrades to no visual feedback, not a broken
// operation, so it's only logged, never thrown onward. Returns whether it's
// now actually shown — the caller must only call closeBusyView if this
// returned true, or it may report a spurious close failure for a view that
// was never up.
export async function showBusyView(context: string): Promise<boolean> {
  try {
    // showPluginView()/closePluginView() resolve to a plain boolean, NOT
    // {success, result} like every other SDK call — confirmed against
    // NativePluginManager's own type declaration. Checking `.success` on
    // it is always undefined, silently miscategorizing every call.
    const ok = await PluginManager.showPluginView();
    if (!ok) { console.error(`${LOG} ${context} showPluginView returned false`); return false; }
    notifyShown();
    return true;
  } catch (e) {
    dlog(`${LOG} ${context} showPluginView failed: ${e}`);
    return false;
  }
}

// Close it. Logs a false result, not just a thrown exception — a silent
// failure here (as opposed to a thrown error) would leave the "working"
// card stuck with no trace of why.
export async function closeBusyView(context: string): Promise<void> {
  try {
    const ok = await PluginManager.closePluginView();
    if (!ok) console.error(`${LOG} ${context} closePluginView returned false`);
  } catch (e) {
    dlog(`${LOG} ${context} closePluginView failed: ${e}`);
  }
}

// `alert()` silently no-ops while the busy view is showing (documented SDK
// gotcha, see SDK_DOC.md). Every action is only ever invoked after its
// caller has already shown the busy view, so a raw `alert()` on any of
// their failure paths is invisible to the user — they see nothing at all
// instead of the intended error message. Close the view first; the
// caller's own `finally` closing it again afterward is a harmless no-op.
// Only use this on a path that's about to return — it doesn't reopen the
// view, since none of the current callers need to keep working after one
// of these alerts.
export async function alertOverBusyView(context: string, message: string): Promise<void> {
  await closeBusyView(context);
  alert(message);
}
