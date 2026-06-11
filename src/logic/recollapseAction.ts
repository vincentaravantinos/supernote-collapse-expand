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
import { iconRectFromElements, readUserData, writeSection } from '../utils/userDataManager';
import { forgetSection } from './expandedRegistry';
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

  for (const el of partEls) {
    if (typeof el.numInPage === 'number') numSet.add(el.numInPage);
    const data = await serializeElement(el);
    if (data) newCollapsed.push({ numInPage: el.numInPage, data });
  }

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
  for (const el of all) {
    if (readUserData(el) !== null) continue; // ours or another section's
    if (typeof el.numInPage !== 'number' || preservedSet.has(el.numInPage)) continue; // pre-existing
    if (!ABSORBABLE_TYPES.has(el.type)) continue;
    const data = await serializeElement(el);
    if (!data) continue;
    const bbox = contentBoundingBox([{ numInPage: el.numInPage, data }], pageSize);
    if (!bbox || !rectsOverlap(bbox, absorbRect)) continue;
    numSet.add(el.numInPage);
    newCollapsed.push({ numInPage: el.numInPage, data });
    absorbed++;
  }
  if (absorbed > 0) dlog(`${LOG} recollapse absorbed=${absorbed} new element(s) into section ${section.id}`);

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

  // Delete parts + absorbed + mask rings (REAL file; surfaced by the single
  // reloadFile in recollapseSections). No saveCurrentNote — it would push the
  // stale cached copy back over the deletion.
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

// Recollapse one or more sections in a single screen refresh: flush, read the
// page once, mutate every section, then dismiss the lasso and reloadFile once.
// Each section's parts/masks come from the same pre-mutation snapshot; deleting
// one section's elements doesn't shift another's page nums, so it stays valid.
export async function recollapseSections(
  sectionIds: string[],
  filePath: string,
  page: number,
): Promise<void> {
  if (sectionIds.length === 0) return;

  // Flush in-flight edits so the read sees strokes drawn while expanded.
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
    forgetSection(id); // no longer expanded — stop live-redrawing its box
  }

  // Dismiss the lasso last, then surface every change with one reloadFile.
  await PluginCommAPI.setLassoBoxState(2);
  await PluginCommAPI.reloadFile();
}
