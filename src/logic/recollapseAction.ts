import { PluginCommAPI, PluginFileAPI, PluginNoteAPI, Rect } from 'sn-plugin-lib';
import {
  dlog,
  LOG,
  MAX_USERDATA_BYTES,
  CE_PLUG_PREFIX,
  ZONE_MARGIN,
} from '../constants';
import { contentBoundingBox, resolveLinkMemberIndices, serializeElement } from '../utils/elementSerializer';
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

// Recollapse ONE section using a pre-fetched element list `all`. Re-serializes
// the section's on-page parts back into the icon's userData and deletes the
// parts/masks. Deliberately does NOT saveCurrentNote / reloadFile / dismiss the
// lasso — `recollapseSections` batches those so N sections cost a single
// refresh. Returns false if the section was skipped (payload over the size
// cap), true otherwise.
async function recollapseOne(
  section: CollapseSection,
  iconElement: any,
  all: any[],
  filePath: string,
  page: number,
  pageSize: { width: number; height: number },
): Promise<boolean> {
  const maskEls: any[] = [];
  const partEls: any[] = [];
  for (const el of all) {
    const ud = readUserData(el);
    if (!ud) continue;
    if (ud.kind === 'mask' && ud.id === section.id) maskEls.push(el);
    else if (ud.kind === 'part' && ud.id === section.id) partEls.push(el);
  }

  let newCollapsed: CollapsedElement[] = [];
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
    dlog(`${LOG} recollapse skippedPreserved=${skippedPreserved} of preservedNums=${preservedSet.size}`);
    await PluginCommAPI.setLassoBoxState(2);
  }

  for (const m of maskEls) {
    if (typeof m.numInPage === 'number') numSet.add(m.numInPage);
  }

  // Re-resolve stroke links' member references (raw page nums of the re-created
  // link -> stable indexes into `newCollapsed`), symmetric with collapse, so
  // the link round-trips across repeated expand/recollapse cycles.
  newCollapsed = resolveLinkMemberIndices(newCollapsed);

  // Re-anchor the section to the icon's CURRENT physical position and recompute
  // the zone (mask fill + boundary outline) from the content's bounding box +
  // margin, STRETCHED to touch the icon. So if the icon was moved while expanded,
  // the content stays put and the zone reaches out to wherever the icon now is
  // (icon dragged bottom-right ⇒ icon at the area's bottom-right; dragged far ⇒
  // big mostly-empty zone). Anchoring iconRect and relativeRect to the same
  // current icon keeps strokes and mask aligned on re-expand (no drift). Move-
  // icon-while-collapsed still relocates the whole section via expand's emrDelta.
  // The zone only reaches the icon's NEAR edge — the expand-time mask renders
  // over the older icon element, so the icon must stay just outside the zone.
  const iconNow = iconRectFromElements(all, section, iconElement);
  const bbox = contentBoundingBox(newCollapsed, pageSize);
  let iconRect = section.iconRect;
  let relativeRect = section.relativeRect;
  if (bbox) {
    const r = {
      left: bbox.left - ZONE_MARGIN,
      top: bbox.top - ZONE_MARGIN,
      right: bbox.right + ZONE_MARGIN,
      bottom: bbox.bottom + ZONE_MARGIN,
    };
    const zone = {
      left: iconNow.right <= r.left ? iconNow.right : r.left,
      top: iconNow.bottom <= r.top ? iconNow.bottom : r.top,
      right: iconNow.left >= r.right ? iconNow.left : r.right,
      bottom: iconNow.top >= r.bottom ? iconNow.top : r.bottom,
    };
    iconRect = {
      left: Math.round(iconNow.left),
      top: Math.round(iconNow.top),
      right: Math.round(iconNow.right),
      bottom: Math.round(iconNow.bottom),
    };
    relativeRect = {
      left: Math.round(zone.left) - iconRect.left,
      top: Math.round(zone.top) - iconRect.top,
      width: Math.round(zone.right - zone.left),
      height: Math.round(zone.bottom - zone.top),
    };
  }

  // Update section state. Drop preservedNums — only meaningful while expanded.
  const updatedSection: CollapseSection = {
    ...section,
    collapsedElements: newCollapsed,
    iconRect,
    relativeRect,
    isExpanded: false,
    preservedNums: undefined,
  };

  const payload = CE_PLUG_PREFIX + JSON.stringify(updatedSection);
  dlog(`${LOG} SIZE recollapse payload=${payload.length} bytes for ${newCollapsed.length} element(s)`);
  if (payload.length > MAX_USERDATA_BYTES) {
    alert('Content too large to re-collapse. Remove some content from this section.');
    return false;
  }

  // Delete tagged + new content + mask rings (writes the REAL file; surfaced by
  // the single reloadFile in recollapseSections). No saveCurrentNote here — it
  // would push the still-stale cached copy back over the deletion.
  const numsToDelete = Array.from(numSet);
  if (numsToDelete.length > 0) {
    const delRes: any = await PluginFileAPI.deleteElements(filePath, page, numsToDelete);
    if (!delRes?.success) {
      console.error(`${LOG} deleteElements failed res=${JSON.stringify(delRes)}`);
    }
  }

  const ok = await writeSection(filePath, page, iconElement, updatedSection);
  if (!ok) console.error(`${LOG} failed to update section userData after recollapse`);
  return true;
}

// Recollapse one or more sections. The user can trigger recollapse by lassoing
// any of a section's content/mask (not just the icon), and a single selection
// can span several expanded sections — all of them are recollapsed here.
//
// Flush once, read the page once, mutate every section, then dismiss the lasso
// and reloadFile ONCE — so N sections cost a SINGLE on-screen refresh. Each
// section's parts/masks are read from the same pre-mutation snapshot; sections
// don't overlap, and deleting one section's elements doesn't affect another's
// page nums, so the shared snapshot stays valid across the loop.
export async function recollapseSections(
  sectionIds: string[],
  filePath: string,
  page: number,
): Promise<void> {
  if (sectionIds.length === 0) return;

  // Flush the user's in-flight edits so the read below sees strokes drawn while
  // expanded. Done once, before any mutation.
  await PluginNoteAPI.saveCurrentNote();

  const allRes: any = await PluginFileAPI.getElements(page, filePath);
  const all: any[] = allRes?.success && Array.isArray(allRes.result) ? allRes.result : [];

  const sizeRes: any = await PluginFileAPI.getPageSize(filePath, page);
  const pageSize = sizeRes?.success && sizeRes.result
    ? { width: sizeRes.result.width, height: sizeRes.result.height }
    : { width: 1404, height: 1872 };

  const iconById = new Map<string, any>();
  for (const el of all) {
    const ud = readUserData(el);
    if (ud?.kind === 'section' && ud.section?.id) iconById.set(ud.section.id, el);
  }

  for (const id of sectionIds) {
    const icon = iconById.get(id);
    const ud = icon ? readUserData(icon) : null;
    if (!icon || ud?.kind !== 'section') {
      console.error(`${LOG} recollapse: no section icon for id=${id} (orphaned content?) — skipping`);
      continue;
    }
    await recollapseOne(ud.section, icon, all, filePath, page, pageSize);
  }

  // Dismiss the user's lasso LAST, then surface every deletion/userData update
  // with a single reloadFile (writes hit the REAL file; reloadFile syncs
  // cached:=real). One refresh regardless of how many sections recollapsed.
  await PluginCommAPI.setLassoBoxState(2);
  await PluginCommAPI.reloadFile();
}
