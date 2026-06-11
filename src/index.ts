import { PluginCommAPI } from 'sn-plugin-lib';
import { BUILD_TAG, dlog, LOG } from './constants';
import { readUserData } from './utils/userDataManager';
import { summarizeElements } from './utils/diagnostics';
import { collapseAction } from './logic/collapseAction';
import { expandSections } from './logic/expandAction';
import { recollapseSections } from './logic/recollapseAction';
import { acquireBusy, releaseBusy } from './logic/busy';

// Re-entrancy guard (shared with the motion-driven live redraw via ./logic/busy):
// the button can be tapped again while a previous invocation is still awaiting
// SDK calls, and a drag-release can fire mid-action. A concurrent second run
// would interleave saveCurrentNote / lasso / insert state and corrupt the note
// (audit ②). Ignore re-entrant presses until the current one finishes.

// DRIFT PROBE (temporary): a monotonic per-action counter so the logcat is
// self-segmenting. Each action emits "[CE-PROBE] #N <TYPE> BEGIN/END" markers;
// the note app's own "exist Trails:" (leaking plugin trail cache) and
// "mTrailNumber" (live render model) lines fall between them, so drift_watch.sh
// can render one drift row per action and Ratta can read the raw log directly.
// Resets to 0 only when the pluginhost process restarts. Strip once reported.
let actionSeq = 0;
const PROBE = `${LOG} [CE-PROBE]`;

export async function handleMainAction() {
  if (!acquireBusy()) {
    dlog(`${LOG} handleMainAction already running — ignoring re-entrant button press`);
    // Tell the user the rejection is intentional — otherwise a swallowed tap
    // looks like a broken button. This fires while a prior collapse/expand is
    // still in flight (operations can take several seconds, longer as the note
    // grows). Critical feedback, so it justifies an alert() despite audit ⑧.
    alert('Collapse/Expand is still busy — please wait a moment.');
    return;
  }
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
    releaseBusy();
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

    // Classify the selection. RECOLLAPSE is triggered by lassoing the icon OR
    // any element that belongs to an expanded section (its CE_PART content or
    // CE_MASK), and recollapses every expanded section the lasso spans. EXPAND
    // and COLLAPSE are only reachable when no expanded section is referenced —
    // parts/masks exist only while a section is expanded, so their presence
    // unambiguously means "recollapse". Recollapse takes priority: a lasso that
    // mixes an expanded section with a collapsed icon recollapses the expanded
    // one(s) and ignores the collapse/expand this press.
    const expandedIds = new Set<string>();
    const collapsedTargets: { section: any; icon: any }[] = [];
    const seenCollapsed = new Set<string>();
    for (const el of elements) {
      const ud = readUserData(el);
      if (!ud) continue;
      if (ud.kind === 'part' || ud.kind === 'mask') {
        expandedIds.add(ud.id);
      } else if (ud.kind === 'section') {
        if (ud.section.isExpanded) expandedIds.add(ud.section.id);
        else if (!seenCollapsed.has(ud.section.id)) {
          seenCollapsed.add(ud.section.id);
          collapsedTargets.push({ section: ud.section, icon: el });
        }
      }
    }

    try {
      if (expandedIds.size > 0) {
        // Recollapse every expanded section the lasso spans, batched into a
        // single refresh. recollapseSections resolves each icon by id and works
        // by section id, so anything else in the lasso is irrelevant to it.
        const ids = Array.from(expandedIds);
        actionSeq++;
        dlog(`${PROBE} #${actionSeq} RECOLLAPSE BEGIN page=${page} build=${BUILD_TAG} sections=${ids.length}`);
        try {
          await recollapseSections(ids, filePath, page);
        } finally {
          dlog(`${PROBE} #${actionSeq} RECOLLAPSE END`);
        }
      } else if (collapsedTargets.length > 0) {
        // Expand every collapsed section in the lasso, batched into a single
        // refresh; loose strokes in the selection are left in place.
        actionSeq++;
        dlog(`${PROBE} #${actionSeq} EXPAND BEGIN page=${page} build=${BUILD_TAG} sections=${collapsedTargets.length}`);
        try {
          await expandSections(collapsedTargets, filePath, page);
        } finally {
          dlog(`${PROBE} #${actionSeq} EXPAND END`);
        }
      } else {
        actionSeq++;
        dlog(`${PROBE} #${actionSeq} COLLAPSE BEGIN page=${page} build=${BUILD_TAG}`);
        try {
          dlog(`${LOG} COLLAPSE - elements: ${summarizeElements(elements)}`);
          await collapseAction(filePath, page, elements);
        } finally {
          dlog(`${PROBE} #${actionSeq} COLLAPSE END`);
        }
      }
    } finally {
      for (const el of elements) {
        try { el.recycle?.(); } catch { /* ignore */ }
      }
    }
  } catch (error) {
    console.error(`${LOG} Plugin action failed:`, error);
    alert('An error occurred during processing.');
  } finally {
    clearTimeout(watchdog);
    releaseBusy();
  }
}
