import { PluginCommAPI, PluginFileAPI, PluginNoteAPI, Rect } from 'sn-plugin-lib';
import {
  LOG,
  MAX_USERDATA_BYTES,
  CE_PLUG_PREFIX,
} from '../constants';
import { serializeElement } from '../utils/elementSerializer';
import { iconRectFromElements, readUserData, writeSection } from '../utils/userDataManager';
import { CollapseSection, CollapsedElement } from '../model/types';

// EXPERIMENT (reproducibility probe): recollapse used to open a SECOND
// programmatic lasso mid-operation (lassoElements(contentRect) +
// getLassoElements) to absorb strokes the user drew on top while expanded,
// then setLassoBoxState(2) BEFORE deleteElements. The system log
// (AreaSelectionView state 2 -> areaSelectionFinish op 17 -> loadLayer) shows
// that state-2 commit is ASYNC and lands AFTER the delete returns — racing it,
// which lines up with the non-deterministic "delete reports success but
// no-ops" failures. collapse (reliable) never does this: it mutates first and
// dismisses the lasso LAST.
//
// With this false, recollapse mirrors collapse: delete tagged parts/masks by
// number, dismiss the (user's) lasso once at the very end. Cost: strokes drawn
// on top while expanded are not absorbed back into the section. Flip to true
// to restore the old absorbing behavior (one line).
const ABSORB_STROKES_VIA_LASSO = false;

export async function recollapseAction(
  section: CollapseSection,
  iconElement: any,
  filePath: string,
  page: number,
) {
  // Flush any in-memory edits to the file so getElements below sees strokes
  // the user drew while the section was expanded.
  await PluginNoteAPI.saveCurrentNote();

  // 1. Find every element belonging to this section via userData id.
  const allRes: any = await PluginFileAPI.getElements(page, filePath);
  const all: any[] = allRes?.success && Array.isArray(allRes.result) ? allRes.result : [];

  // Read the icon's CURRENT rect from this fresh list, not from the lassoed
  // element (which can report a stale rect after a move).
  const iconRectNow = iconRectFromElements(all, section, iconElement);

  const maskEls: any[] = [];
  const partEls: any[] = [];
  for (const el of all) {
    const ud = readUserData(el);
    if (!ud) continue;
    if (ud.kind === 'mask' && ud.id === section.id) maskEls.push(el);
    else if (ud.kind === 'part' && ud.id === section.id) partEls.push(el);
  }

  const newCollapsed: CollapsedElement[] = [];
  const numSet = new Set<number>();

  for (const el of partEls) {
    if (typeof el.numInPage === 'number') numSet.add(el.numInPage);
    const data = await serializeElement(el);
    if (data) newCollapsed.push({ numInPage: el.numInPage, data });
  }

  if (ABSORB_STROKES_VIA_LASSO) {
    // contentRect (computed from the section state at expand time) bounds the
    // area where user-added strokes drawn on top while expanded would sit.
    const contentRect: Rect = {
      left: section.iconRect.left + section.relativeRect.left,
      top: section.iconRect.top + section.relativeRect.top,
      right: section.iconRect.left + section.relativeRect.left + section.relativeRect.width,
      bottom: section.iconRect.top + section.relativeRect.top + section.relativeRect.height,
    };
    // Lasso contentRect to absorb strokes the user drew during expansion.
    // Skip any element whose numInPage was recorded in section.preservedNums
    // at expand time — those are pre-existing user content that must stay in
    // place, not be absorbed into the section.
    const preservedSet = new Set<number>(section.preservedNums ?? []);
    await PluginCommAPI.lassoElements(contentRect);
    const lassoRes: any = await PluginCommAPI.getLassoElements();
    const lassoed: any[] = lassoRes?.success ? (lassoRes.result ?? []) : [];
    let skippedPreserved = 0;
    for (const el of lassoed) {
      if (readUserData(el) !== null) continue; // skip icon, mask, already-tagged parts
      if (typeof el.numInPage === 'number' && preservedSet.has(el.numInPage)) {
        skippedPreserved++;
        continue;
      }
      if (typeof el.numInPage === 'number') numSet.add(el.numInPage);
      const data = await serializeElement(el);
      if (data) newCollapsed.push({ numInPage: el.numInPage, data });
    }
    for (const el of lassoed) { try { el.recycle?.(); } catch { /* ignore */ } }
    console.log(`${LOG} recollapse skippedPreserved=${skippedPreserved} of preservedNums=${preservedSet.size}`);

    // Close the programmatic read-lasso now that we've read it, BEFORE the
    // deleteElements below. A dangling lasso holding lifted pre-existing
    // strokes is what makes the by-number delete silently no-op in the
    // "strokes below" case.
    await PluginCommAPI.setLassoBoxState(2);
  }

  for (const m of maskEls) {
    if (typeof m.numInPage === 'number') numSet.add(m.numInPage);
  }

  // 3. Update section state. Drop preservedNums — only meaningful while expanded.
  const updatedSection: CollapseSection = {
    ...section,
    collapsedElements: newCollapsed,
    isExpanded: false,
    iconRect: iconRectNow,
    preservedNums: undefined,
  };

  const payload = CE_PLUG_PREFIX + JSON.stringify(updatedSection);
  console.log(`${LOG} SIZE recollapse payload=${payload.length} bytes for ${newCollapsed.length} element(s)`);
  if (payload.length > MAX_USERDATA_BYTES) {
    alert('Content too large to re-collapse. Remove some content from this section.');
    return;
  }

  // 4. Delete tagged + new content + mask rings, commit.
  const numsToDelete = Array.from(numSet);
  if (numsToDelete.length > 0) {
    const delRes: any = await PluginFileAPI.deleteElements(filePath, page, numsToDelete);
    if (!delRes?.success) {
      console.error(`${LOG} deleteElements failed res=${JSON.stringify(delRes)}`);
    }

    // Deliberately NO saveCurrentNote here. deleteElements removed the
    // parts/masks from the REAL note file; saveCurrentNote would push the
    // (often still-stale) CACHED/displayed copy — which still HAS the parts —
    // back over the real file and re-add them. reloadFile at the end reloads
    // the displayed copy FROM the real file, deterministically surfacing the
    // deletion. See SDK_DOC.md ("Plugin writes hit the REAL file …").
  }

  // 5. Update icon userData.
  const ok = await writeSection(filePath, page, iconElement, updatedSection);
  if (!ok) console.error(`${LOG} failed to update section userData after recollapse`);

  // Dismiss the user's icon-lasso LAST — after all mutations — exactly as
  // collapse does. Doing it here (rather than mid-operation, before the
  // delete) keeps the async state-2 commit from racing the deleteElements.
  await PluginCommAPI.setLassoBoxState(2);

  await PluginCommAPI.reloadFile();
}
