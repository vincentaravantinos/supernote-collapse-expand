import { PluginCommAPI } from 'sn-plugin-lib';
import { BUILD_TAG, dlog, LOG } from './constants';
import { readUserData } from './utils/userDataManager';
import { summarizeElements, summarizeSection } from './utils/diagnostics';
import { collapseAction } from './logic/collapseAction';
import { expandAction } from './logic/expandAction';
import { recollapseAction } from './logic/recollapseAction';

// Re-entrancy guard: the button can be tapped again while a previous
// invocation is still awaiting SDK calls. A concurrent second run would
// interleave saveCurrentNote / lasso / insert state and corrupt the note
// (audit ②). Ignore re-entrant presses until the current one finishes.
let isRunning = false;

// DRIFT PROBE (temporary): a monotonic per-action counter so the logcat is
// self-segmenting. Each action emits "[CE-PROBE] #N <TYPE> BEGIN/END" markers;
// the note app's own "exist Trails:" (leaking plugin trail cache) and
// "mTrailNumber" (live render model) lines fall between them, so drift_watch.sh
// can render one drift row per action and Ratta can read the raw log directly.
// Resets to 0 only when the pluginhost process restarts. Strip once reported.
let actionSeq = 0;
const PROBE = `${LOG} [CE-PROBE]`;

export async function handleMainAction() {
  if (isRunning) {
    dlog(`${LOG} handleMainAction already running — ignoring re-entrant button press`);
    // Tell the user the rejection is intentional — otherwise a swallowed tap
    // looks like a broken button. This fires while a prior collapse/expand is
    // still in flight (operations can take several seconds, longer as the note
    // grows). Critical feedback, so it justifies an alert() despite audit ⑧.
    alert('Collapse/Expand is still busy — please wait a moment.');
    return;
  }
  isRunning = true;
  // Watchdog: if an SDK call truly hangs (the note enters a bad state and a
  // call never returns), the finally below never runs and the guard would
  // wedge the button permanently. Release it after a timeout so the plugin
  // self-recovers. This is ONLY for genuine hangs — it must be longer than any
  // legitimately-slow operation, because firing it while an op is still
  // progressing re-opens the re-entrancy window. Large selections on big notes
  // (serialize many strokes + insert + reloadFile re-render + the note app's
  // own backup) can legitimately run tens of seconds, so 60s, not 20s.
  const WATCHDOG_MS = 60000;
  const watchdog = setTimeout(() => {
    console.error(`${LOG} handleMainAction watchdog fired (operation hung >${WATCHDOG_MS / 1000}s) — releasing re-entrancy guard`);
    isRunning = false;
  }, WATCHDOG_MS);
  try {
    const filePathRes: any = await PluginCommAPI.getCurrentFilePath();
    const pageRes: any = await PluginCommAPI.getCurrentPageNum();
    if (!filePathRes?.success || typeof filePathRes.result !== 'string') {
      alert('Unable to determine current file path.');
      return;
    }
    if (!pageRes?.success || typeof pageRes.result !== 'number') {
      alert('Unable to determine current page.');
      return;
    }
    const filePath = filePathRes.result as string;
    const page = pageRes.result as number;

    const elementsRes: any = await PluginCommAPI.getLassoElements();
    const elements: any[] = elementsRes?.success ? (elementsRes.result ?? []) : [];
    if (elements.length === 0) {
      alert('Please make a selection first.');
      return;
    }

    let iconElement: any = null;
    let section = null;
    for (const el of elements) {
      const ud = readUserData(el);
      if (ud?.kind === 'section') {
        iconElement = el;
        section = ud.section;
        break;
      }
    }

    actionSeq++;
    const actionType = iconElement && section
      ? (section.isExpanded ? 'RECOLLAPSE' : 'EXPAND')
      : 'COLLAPSE';
    dlog(`${PROBE} #${actionSeq} ${actionType} BEGIN page=${page} build=${BUILD_TAG}`);
    try {
      if (iconElement && section) {
        if (section.isExpanded) {
          dlog(`${LOG} RECOLLAPSE - section: ${summarizeSection(section)}`);
          await recollapseAction(section, iconElement, filePath, page);
        } else {
          dlog(`${LOG} EXPAND - section: ${summarizeSection(section)}`);
          await expandAction(section, iconElement, filePath, page);
        }
      } else {
        dlog(`${LOG} COLLAPSE - elements: ${summarizeElements(elements)}`);
        await collapseAction(filePath, page, elements);
      }
    } finally {
      dlog(`${PROBE} #${actionSeq} ${actionType} END`);
      for (const el of elements) {
        try { el.recycle?.(); } catch { /* ignore */ }
      }
    }
  } catch (error) {
    console.error(`${LOG} Plugin action failed:`, error);
    alert('An error occurred during processing.');
  } finally {
    clearTimeout(watchdog);
    isRunning = false;
  }
}
