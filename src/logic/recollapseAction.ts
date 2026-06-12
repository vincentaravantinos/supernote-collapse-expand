import { PluginCommAPI, PluginFileAPI, PluginNoteAPI, Rect } from 'sn-plugin-lib';
import {
  dlog,
  ELEMENT_TYPES,
  LOG,
  MAX_USERDATA_BYTES,
  CE_PLUG_PREFIX,
  ZONE_MARGIN,
} from '../constants';
import { contentBoundingBox, resolveLinkMemberIndices, serializeElement } from '../utils/elementSerializer';
import { rectsOverlap, stretchZoneToIcon } from '../utils/geometryHelpers';
import { getIconByNum, iconRectFromElements, readUserData, writeSection } from '../utils/userDataManager';
import { forgetSection, getExpandedEntry } from './expandedRegistry';
import { CollapseSection, CollapsedElement } from '../model/types';

// Types we absorb when drawn on an expanded section (strokes / text / geometry).
const ABSORBABLE_TYPES = new Set<number>([
  ELEMENT_TYPES.STROKE,
  ELEMENT_TYPES.TEXT,
  ELEMENT_TYPES.TEXT_DIGEST_QUOTE,
  ELEMENT_TYPES.TEXT_DIGEST_CREATE,
  ELEMENT_TYPES.GEO,
]);

// Recollapse ONE section from a pre-fetched element list `all`: re-serialize its
// on-page parts back into the icon's userData and delete the parts/masks. Does
// NOT saveCurrentNote / reloadFile / dismiss the lasso — recollapseSections
// batches those. Returns false if skipped (payload over the size cap).
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
    if ((ud.kind === 'mask' || ud.kind === 'frame') && ud.id === section.id) maskEls.push(el);
    else if (ud.kind === 'part' && ud.id === section.id) partEls.push(el);
  }

  let newCollapsed: CollapsedElement[] = [];
  const numSet = new Set<number>();

  const tParts = Date.now();
  for (const el of partEls) {
    if (typeof el.numInPage === 'number') numSet.add(el.numInPage);
    const data = await serializeElement(el);
    if (data) newCollapsed.push({ numInPage: el.numInPage, data });
  }
  dlog(`${LOG} PERF recollapse serializeParts=${Date.now() - tParts}ms parts=${partEls.length}`);

  // Absorb NEW elements drawn on top of the section while expanded (untagged and
  // num NOT in preservedNums = drawn after expand) whose bbox overlaps the
  // section area. The num-check skips pre-existing content cheaply, so only the
  // few real candidates get a bbox. Content elsewhere stays in place.
  const preservedSet = new Set<number>(section.preservedNums ?? []);
  const absorbRect: Rect = {
    left: section.iconRect.left + section.relativeRect.left,
    top: section.iconRect.top + section.relativeRect.top,
    right: section.iconRect.left + section.relativeRect.left + section.relativeRect.width,
    bottom: section.iconRect.top + section.relativeRect.top + section.relativeRect.height,
  };
  let absorbed = 0;
  let drained = 0;
  const tAbsorb = Date.now();
  for (const el of all) {
    if (readUserData(el) !== null) continue; // ours or another section's
    if (typeof el.numInPage !== 'number' || preservedSet.has(el.numInPage)) continue; // pre-existing
    if (!ABSORBABLE_TYPES.has(el.type)) continue;
    const data = await serializeElement(el);
    drained++;
    if (!data) continue;
    const bbox = contentBoundingBox([{ numInPage: el.numInPage, data }], pageSize);
    if (!bbox || !rectsOverlap(bbox, absorbRect)) continue;
    numSet.add(el.numInPage);
    newCollapsed.push({ numInPage: el.numInPage, data });
    absorbed++;
  }
  dlog(`${LOG} PERF recollapse absorb=${Date.now() - tAbsorb}ms drained=${drained} absorbed=${absorbed} preserved=${preservedSet.size}`);

  for (const m of maskEls) {
    if (typeof m.numInPage === 'number') numSet.add(m.numInPage);
  }

  newCollapsed = resolveLinkMemberIndices(newCollapsed);

  // Re-anchor to the icon's CURRENT position and recompute the zone from the
  // content bbox + margin, stretched to touch the icon. So an icon moved while
  // expanded leaves content in place and the zone reaches out to the icon (the
  // icon ends up at the area's edge; far ⇒ big mostly-empty zone). Anchoring
  // iconRect and relativeRect to the same icon keeps strokes and mask aligned on
  // re-expand.
  const iconNow = iconRectFromElements(all, section, iconElement);
  const bbox = contentBoundingBox(newCollapsed, pageSize);
  let iconRect = section.iconRect;
  let relativeRect = section.relativeRect;
  if (bbox) {
    const zone = stretchZoneToIcon(bbox, ZONE_MARGIN, iconNow);
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

  // Drop preservedNums — only meaningful while expanded.
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

  // CRASH-SAFETY: write the updated section (parts + absorbed strokes,
  // re-anchored) into the icon's userData BEFORE deleting the on-page parts.
  // While expanded, those on-page parts are the only durable copy; writing the
  // icon first means a crash between write and delete leaves both copies present
  // (recoverable), never neither. iconElement comes from the page-wide
  // getElements snapshot (fresh, and its num is stable across the delete below),
  // so writeSection can skip re-reading.
  const tWrite = Date.now();
  const ok = await writeSection(filePath, page, iconElement, updatedSection, iconElement);
  dlog(`${LOG} PERF recollapse writeSection=${Date.now() - tWrite}ms`);
  if (!ok) {
    // userData not updated — leave the on-page parts in place, they're still the
    // only durable copy.
    console.error(`${LOG} failed to update section userData after recollapse — leaving on-page parts in place`);
    alert("Supernote couldn't complete the recollapse — please try again.");
    return false;
  }

  // Content now durable in the icon. Delete parts + absorbed + mask rings (REAL
  // file; surfaced by the single reloadFile in recollapseSections). No
  // saveCurrentNote — it would push the stale cached copy back over the deletion.
  const numsToDelete = Array.from(numSet);
  if (numsToDelete.length > 0) {
    const tDel = Date.now();
    const delRes: any = await PluginFileAPI.deleteElements(filePath, page, numsToDelete);
    dlog(`${LOG} PERF recollapse deleteElements=${Date.now() - tDel}ms n=${numsToDelete.length}`);
    if (!delRes?.success) {
      console.error(`${LOG} recollapse deleteElements failed res=${JSON.stringify(delRes)}`);
      alert('Recollapsed, but some leftover elements could not be removed — please retry.');
    }
  }
  return true;
}

// Above this many "new since expand" candidates, a full getElements is cheaper
// than fetching each individually — and a count this high means preservedNums is
// stale/empty, so the full read is also safer. Triggers the fallback.
const FAST_CANDIDATE_CAP = 60;

// Fast read for a single same-session section: resolve the icon by its cached num
// and fetch only the elements that aren't pre-existing (the section's
// parts/masks/frame + any strokes drawn since expand) via getElementNumList +
// per-num getElement. Returns null to tell the caller to fall back to a full
// getElements (no registry entry after a restart, stale icon num, or too many
// candidates). recollapseOne works over whatever element list it's given.
async function fastSectionElements(
  id: string,
  filePath: string,
  page: number,
): Promise<{ section: CollapseSection; icon: any; elements: any[] } | null> {
  const entry = getExpandedEntry(id);
  if (!entry || typeof entry.iconNum !== 'number') { dlog(`${LOG} recollapse fast: no registry icon num for ${id} — fallback`); return null; }
  const icon = await getIconByNum(filePath, page, entry.iconNum, id);
  if (!icon) { dlog(`${LOG} recollapse fast: icon num ${entry.iconNum} stale for ${id} — fallback`); return null; }
  const ud = readUserData(icon);
  if (ud?.kind !== 'section') return null;

  const t = Date.now();
  const nlRes: any = await PluginFileAPI.getElementNumList(filePath, page);
  const allNums: number[] = nlRes?.success && Array.isArray(nlRes.result) ? nlRes.result : [];
  const preserved = new Set<number>(ud.section.preservedNums ?? []);
  const candidateNums = allNums.filter((n) => !preserved.has(n) && n !== entry.iconNum);
  if (candidateNums.length > FAST_CANDIDATE_CAP) { dlog(`${LOG} recollapse fast: ${candidateNums.length} candidates > cap — fallback`); return null; }

  const elements: any[] = [];
  for (const n of candidateNums) {
    const r: any = await PluginFileAPI.getElement(filePath, page, n);
    if (r?.success && r.result) elements.push(r.result);
  }
  dlog(`${LOG} PERF recollapse fastRead=${Date.now() - t}ms candidates=${candidateNums.length} pageTotal=${allNums.length}`);
  return { section: ud.section, icon, elements };
}

// Recollapse one or more sections in a single screen refresh: flush, read the
// section's elements (fast path, or a full getElements), mutate, then dismiss the
// lasso and reloadFile once.
export async function recollapseSections(
  sectionIds: string[],
  filePath: string,
  page: number,
): Promise<void> {
  if (sectionIds.length === 0) return;

  // Flush in-flight edits so the read sees strokes drawn while expanded.
  const tSave = Date.now();
  await PluginNoteAPI.saveCurrentNote();
  dlog(`${LOG} PERF recollapse saveCurrentNote=${Date.now() - tSave}ms`);

  const sizeRes: any = await PluginFileAPI.getPageSize(filePath, page);
  const pageSize = sizeRes?.success && sizeRes.result
    ? { width: sizeRes.result.width, height: sizeRes.result.height }
    : { width: 1404, height: 1872 };

  // Fast path: a single same-session section whose icon num we cached at expand.
  // Fetch just the icon + the section's own elements (the nums NOT preserved at
  // expand = its parts/masks/frame and any strokes drawn since) instead of
  // marshalling the whole page. Falls back to a full getElements otherwise (after
  // a restart the registry is empty; the icon num is stale; the candidate set is
  // implausibly large; or several sections are selected).
  const fast = sectionIds.length === 1
    ? await fastSectionElements(sectionIds[0], filePath, page)
    : null;

  if (fast) {
    await recollapseOne(fast.section, fast.icon, fast.elements, filePath, page, pageSize);
    forgetSection(sectionIds[0]);
  } else {
    const tGE = Date.now();
    const allRes: any = await PluginFileAPI.getElements(page, filePath);
    const all: any[] = allRes?.success && Array.isArray(allRes.result) ? allRes.result : [];
    dlog(`${LOG} PERF recollapse getElements(full)=${Date.now() - tGE}ms total=${all.length} el`);

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
      forgetSection(id); // no longer expanded — stop live-redrawing its box
    }
  }

  // Dismiss the lasso last, then surface every change with one reloadFile.
  await PluginCommAPI.setLassoBoxState(2);
  const tReload = Date.now();
  await PluginCommAPI.reloadFile();
  dlog(`${LOG} PERF recollapse reload=${Date.now() - tReload}ms`);
}
