import { PluginCommAPI } from 'sn-plugin-lib';
import { BUILD_TAG, dlog, ELEMENT_TYPES, LOG } from './constants';
import { readUserData } from './utils/userDataManager';
import { summarizeElements } from './utils/diagnostics';
import { collapseAction } from './logic/collapseAction';
import { expandSections } from './logic/expandAction';
import { recollapseSections } from './logic/recollapseAction';
import { handleNameAction } from './logic/nameAction';
import { runExclusive } from './logic/operation';
import { isLandscape } from './utils/orientation';
import { getCurrentFileContext } from './utils/currentFile';

// Per-action counter + tag bracketing each action's logs with BEGIN/END markers
// that carry the build stamp (so the trace confirms which build is live).
let actionSeq = 0;
const PROBE = `${LOG} [CE-PROBE]`;

export async function handleMainAction() {
  if (await isLandscape()) {
    alert('Collapse / Expand doesn\'t work in landscape mode — please switch to portrait.');
    return;
  }
  await runExclusive('handleMainAction', async (op) => {
    const ctx = await getCurrentFileContext();
    if (!ctx) {
      alert('Unable to determine the current note and page.');
      return;
    }
    const { filePath, page } = ctx;

    const elementsRes: any = await PluginCommAPI.getLassoElements();
    const elements: any[] = elementsRes?.success ? (elementsRes.result ?? []) : [];
    if (elements.length === 0) {
      alert('Please make a selection first.');
      return;
    }

    // Busy overlay: the SDK has no non-blocking busy primitive (every native
    // dialog is a blocking modal), so we render the plugin's own React view (a
    // small "working" card, see App.tsx). Shown AFTER the selection is read,
    // so showing the view can't eat the lasso the operation still depends on.
    await op.showView();

    // Classify the selection by the sections it references (an icon, or an
    // expanded section's restored content / mask) and the loose handwriting
    // next to them. A finger tap is the main way to toggle one section; the
    // button offers everything else, running the only applicable action
    // directly and asking only when several apply (REQ-700/710).
    const expandedIds = new Set<string>();
    const collapsedTargets: { section: any; icon: any }[] = [];
    const iconsById = new Map<string, { section: any; icon: any }>();
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
      } else if (ud.kind === 'plug' && !iconsById.has(ud.section.id)) {
        iconsById.set(ud.section.id, { section: ud.section, icon: el });
        if (ud.section.isExpanded) expandedIds.add(ud.section.id);
        else collapsedTargets.push({ section: ud.section, icon: el });
      }
    }
    const sectionCount = expandedIds.size + collapsedTargets.length;

    // REQ-740: nothing the button can do here — point at the finger tap.
    const nothingToDo = async () => {
      await op.ask('Nothing to do for this selection. To expand or collapse a section, tap its icon with your finger.', [{ id: 'ok', label: 'OK' }]);
      await PluginCommAPI.setLassoBoxState(2);
    };

    // Every branch below may change the page.
    op.touched(filePath, page);
    try {
      actionSeq++;
      if (sectionCount >= 2) {
        let choice = expandedIds.size === 0 ? 'expand' : collapsedTargets.length === 0 ? 'recollapse' : null;
        if (!choice) {
          choice = await op.ask('Your selection includes both collapsed and expanded sections.', [
            { id: 'expand', label: 'Expand all sections' },
            { id: 'recollapse', label: 'Collapse all sections' },
            { id: 'cancel', label: 'Cancel' },
          ]);
        }
        dlog(`${PROBE} #${actionSeq} MULTI ${choice} page=${page} build=${BUILD_TAG} sections=${sectionCount}`);
        if (choice === 'expand') await expandSections(collapsedTargets, filePath, page);
        else if (choice === 'recollapse') await recollapseSections(Array.from(expandedIds), filePath, page);
        else await PluginCommAPI.setLassoBoxState(2);
      } else if (sectionCount === 1) {
        const id = expandedIds.size > 0 ? [...expandedIds][0] : collapsedTargets[0].section.id;
        const target = iconsById.get(id);
        // An expanded section hides the page content that was already under
        // its area, but a lasso still picks it up — that ink is never a name.
        const hidden = new Set<number>(target?.section.isExpanded ? (target.section.preservedNums ?? []) : []);
        const nameInk = nameCandidates.filter((el) => !hidden.has(el.numInPage));
        dlog(`${PROBE} #${actionSeq} ONE-SECTION page=${page} build=${BUILD_TAG} icon=${!!target} ink=${nameInk.length}`);
        const outcome = target ? await handleNameAction(op, target, nameInk, nameTaggedInLasso, filePath, page) : 'nothing';
        if (outcome === 'nothing') await nothingToDo();
        else if (outcome === 'cancel') await PluginCommAPI.setLassoBoxState(2);
      } else if (elements.every((el) => readUserData(el))) {
        // Only names / underlines, without their icon.
        await nothingToDo();
      } else {
        dlog(`${PROBE} #${actionSeq} COLLAPSE page=${page} build=${BUILD_TAG} elements: ${summarizeElements(elements)}`);
        await collapseAction(op, filePath, page, elements);
      }
    } finally {
      for (const el of elements) {
        try { el.recycle?.(); } catch { /* ignore */ }
      }
    }
  }, {
    // The button shares a single-flight guard with the live redraw and the
    // tap shortcut, so a press while a prior op is still in flight is
    // rejected. Tell the user, so a swallowed press doesn't look like a
    // broken button.
    onBusy: () => alert('Collapse/Expand is still busy — please wait a moment.'),
    errorAlert: 'An error occurred during processing.',
  });
}
