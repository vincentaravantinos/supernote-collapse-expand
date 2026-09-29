import { LOG } from '../constants';
import { acquireBusy, releaseBusy, setAwaitingUser } from './busy';
import { buildIconCache } from './iconPageCache';
import { answerDialog, askInView, DialogButton, notifyShown } from './workingViewStore';
import { alertOverBusyView, closeBusyView, isBusyViewShown, showBusyView } from '../utils/busyView';

// Watchdog: if an SDK call truly hangs, the finally never runs and the guard
// would wedge every entry point forever. Release it after a timeout. Must
// exceed any legitimately-slow op (large selections can run tens of seconds),
// else firing it mid-op re-opens the re-entrancy window.
const WATCHDOG_MS = 60000;

// Handle an operation body uses for the "working" card and to say which page
// it changed. Each entry point decides WHEN to show the card (e.g. the live
// redraw only once a real drag is confirmed); runExclusive always closes it.
export class Operation {
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  touchedPage: { filePath: string; page: number } | null = null;

  constructor(readonly context: string) {}

  armWatchdog(): void {
    this.disarmWatchdog();
    this.watchdog = setTimeout(() => {
      console.error(`${LOG} ${this.context} watchdog fired (operation hung >${WATCHDOG_MS / 1000}s) — releasing re-entrancy guard`);
      releaseBusy();
    }, WATCHDOG_MS);
  }

  disarmWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  async showView(): Promise<void> {
    await showBusyView(this.context);
  }

  async closeView(): Promise<void> {
    await closeBusyView(this.context);
  }

  async alert(message: string): Promise<void> {
    await alertOverBusyView(this.context, message);
  }

  // Ask the user in the plugin's own dialog; resolves to the chosen button's
  // id. The card then goes back to "Working…". Neither the watchdog nor the
  // stale-guard check counts the time spent waiting on the user.
  async ask(message: string, buttons: DialogButton[]): Promise<string> {
    const answer = askInView(message, buttons); // state set before the view shows
    this.disarmWatchdog();
    setAwaitingUser(true);
    try {
      await this.showView();
      if (!isBusyViewShown()) answerDialog('cancel'); // no view, no way to answer
      return await answer;
    } finally {
      setAwaitingUser(false);
      this.armWatchdog();
      notifyShown(); // restart the card's cancel-button timer
    }
  }

  // Marks the page as changed, so the tap cache gets rebuilt from it.
  touched(filePath: string, page: number): void {
    this.touchedPage = { filePath, page };
  }
}

// Every note-mutating entry point (button, finger tap, live redraw) runs
// through here: single-flight guard + watchdog, then — whatever the body did
// or threw — rebuild the tap cache for a touched page while the card is still
// up (so the cost isn't paid silently on the next tap, and the cache never
// keeps a stale expanded/collapsed state), close the card, release the guard.
export async function runExclusive(
  context: string,
  body: (op: Operation) => Promise<void>,
  opts: { onBusy?: () => void | Promise<void>; errorAlert?: string } = {},
): Promise<void> {
  if (!acquireBusy()) {
    await opts.onBusy?.();
    return;
  }
  const op = new Operation(context);
  op.armWatchdog();
  try {
    await body(op);
  } catch (e) {
    console.error(`${LOG} ${context} failed: ${e}`);
    if (opts.errorAlert) await op.alert(opts.errorAlert);
  } finally {
    try {
      if (op.touchedPage) await buildIconCache(op.touchedPage.filePath, op.touchedPage.page, { repair: true });
    } catch (e) {
      console.error(`${LOG} ${context} icon cache rebuild failed: ${e}`);
    }
    op.disarmWatchdog();
    await op.closeView();
    releaseBusy();
  }
}
