import { PluginCommAPI, PluginManager } from 'sn-plugin-lib';
import { BUILD_TAG, dlog, ELEMENT_TYPES, LOG } from './constants';
import { readUserData } from './utils/userDataManager';
import { summarizeElements } from './utils/diagnostics';
import { collapseAction } from './logic/collapseAction';
import { expandSections } from './logic/expandAction';
import { recollapseSections } from './logic/recollapseAction';
import { handleNameAction } from './logic/nameAction';
import { acquireBusy, releaseBusy } from './logic/busy';
import { buildIconCache } from './logic/iconPageCache';
import { isLandscape } from './utils/orientation';
import { notifyShown } from './logic/workingViewStore';

// Per-action counter + tag bracketing each action's logs with BEGIN/END markers
// that carry the build stamp (so the trace confirms which build is live).
let actionSeq = 0;
const PROBE = `${LOG} [CE-PROBE]`;

export async function handleMainAction() {
  if (await isLandscape()) {
    alert('Collapse / Expand doesn\'t work in landscape mode — please switch to portrait.');
    return;
  }
  if (!acquireBusy()) {
    // The button shares a single-flight guard with the live redraw, so a tap
    // while a prior op is still in flight is rejected. Tell the user, so a
    // swallowed tap doesn't look like a broken button.
    dlog(`${LOG} handleMainAction already running — ignoring re-entrant button press`);
    alert('Collapse/Expand is still busy — please wait a moment.');
    return;
  }
  // Watchdog: if an SDK call truly hangs, the finally never runs and the guard
  // would wedge the button forever. Release it after a timeout. Must exceed any
  // legitimately-slow op (large selections can run tens of seconds), else firing
  // it mid-op re-opens the re-entrancy window.
  const WATCHDOG_MS = 60000;
  const watchdog = setTimeout(() => {
    console.error(`${LOG} handleMainAction watchdog fired (operation hung >${WATCHDOG_MS / 1000}s) — releasing re-entrancy guard`);
    releaseBusy();
  }, WATCHDOG_MS);
  let viewShown = false; // busy overlay shown for this action?
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

    // Busy overlay: the SDK has no non-blocking busy primitive (every native
    // dialog is a blocking modal), so we render the plugin's own React view (a
    // small "working" card, see App.tsx) via showPluginView and hide it in the
    // finally. Shown AFTER the selection is read, so showing the view can't eat
    // the lasso the operation still depends on.
    try {
      await PluginManager.showPluginView();
      viewShown = true;
      notifyShown();
    } catch (e) {
      dlog(`${LOG} showPluginView failed: ${e}`);
    }

    // Classify the selection. An expanded section referenced by the lasso (its
    // icon, or its CE_PART / CE_MASK) → recollapse; a collapsed icon plus bare
    // untagged ink → name/rename; a collapsed icon alone (or with 2+ icons
    // present) → expand; otherwise → collapse. Recollapse takes priority over
    // everything else when a selection mixes them.
    const expandedIds = new Set<string>();
    const collapsedTargets: { section: any; icon: any }[] = [];
    const seenCollapsed = new Set<string>();
    const nameCandidates: any[] = [];
    const nameTaggedInLasso: any[] = [];
    for (const el of elements) {
      const ud = readUserData(el);
      if (!ud) {
        if (el.type === ELEMENT_TYPES.STROKE) nameCandidates.push(el);
        continue;
      }
      if (ud.kind === 'name') {
        nameTaggedInLasso.push(el);
      } else if (ud.kind === 'part' || ud.kind === 'mask') {
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
        const ids = Array.from(expandedIds);
        actionSeq++;
        dlog(`${PROBE} #${actionSeq} RECOLLAPSE BEGIN page=${page} build=${BUILD_TAG} sections=${ids.length}`);
        try {
          await recollapseSections(ids, filePath, page);
        } finally {
          dlog(`${PROBE} #${actionSeq} RECOLLAPSE END`);
        }
      } else if (collapsedTargets.length === 1 && nameCandidates.length > 0) {
        actionSeq++;
        dlog(`${PROBE} #${actionSeq} NAME BEGIN page=${page} build=${BUILD_TAG}`);
        try {
          // showRattaDialog is a blocking native modal — same suppression risk
          // as alert() while showPluginView is active, so close the view
          // around it and reopen before any further mutation (expand fallback
          // included).
          if (viewShown) {
            try { await PluginManager.closePluginView(); } catch (e) { dlog(`${LOG} closePluginView (pre-dialog) failed: ${e}`); }
            viewShown = false;
          }
          const fallBackToExpand = await handleNameAction(collapsedTargets[0], nameCandidates, nameTaggedInLasso, filePath, page);
          try {
            await PluginManager.showPluginView();
            viewShown = true;
            notifyShown();
          } catch (e) {
            dlog(`${LOG} showPluginView (post-dialog) failed: ${e}`);
          }
          if (fallBackToExpand) {
            await expandSections([collapsedTargets[0]], filePath, page);
          }
        } finally {
          dlog(`${PROBE} #${actionSeq} NAME END`);
        }
      } else if (collapsedTargets.length > 0) {
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
      // Rebuild (not just invalidate) the icon cache eagerly, while the
      // working bubble is already up — moves the cost here instead of
      // paying it silently on the user's next tap.
      await buildIconCache(filePath, page);
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
    if (viewShown) {
      try {
        // DIAGNOSTIC (B-008): log a non-success result, not just a thrown
        // exception — if this silently fails during an app-switch race
        // (same as insertElements/modifyElements did), that would explain
        // the "working" card appearing to never close.
        const closeRes: any = await PluginManager.closePluginView();
        if (!closeRes?.success) console.error(`${LOG} closePluginView res=${JSON.stringify(closeRes)}`);
      } catch (e) {
        dlog(`${LOG} closePluginView failed: ${e}`);
      }
    }
  }
}
