import { PluginCommAPI } from 'sn-plugin-lib';
import { LOG, dlog } from '../constants';

// Dismiss the current lasso selection after its own lassoed elements were
// already deleted (collapse/recollapse/rename all delete-then-dismiss, in
// that order — see each caller's own comment for why the delete comes
// first). Error 904 ("No lasso action has been performed") is expected
// here: the lassoed elements are already gone, so there's nothing left
// for the SDK to dismiss — getLassoElements fails the same way at this
// point. Any other error is worth knowing about.
export async function dismissLassoAfterDelete(context: string): Promise<void> {
  const res: any = await PluginCommAPI.setLassoBoxState(2);
  if (!res?.success) {
    if (res?.error?.code === 904) {
      dlog(`${LOG} ${context} setLassoBoxState res=${JSON.stringify(res)} (expected)`);
    } else {
      console.error(`${LOG} ${context} setLassoBoxState res=${JSON.stringify(res)}`);
    }
  }
}
