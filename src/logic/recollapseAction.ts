import { PluginFileAPI, PluginNoteAPI, Rect } from 'sn-plugin-lib';
import {
  dlog,
  ELEMENT_TYPES,
  ICON_GLYPH,
  LOG,
  MAX_USERDATA_BYTES,
  CE_PLUG_PREFIX,
  ZONE_MARGIN,
} from '../constants';
import { contentBoundingBox, getPageSize, resolveLinkMemberIndices, serializeElement } from '../utils/elementSerializer';
import { rectsOverlap, stretchZoneToIcon } from '../utils/geometryHelpers';
import { getIconByNum, iconRectFromElements, isUnstableNoteError, readUserData, writeSection } from '../utils/userDataManager';
import { ensureAllPermissions } from '../utils/permissions';
import { dismissLassoAfterDelete } from '../utils/lassoHelpers';
import { alertOverBusyView } from '../utils/busyView';
import { reloadFileWithTimeout } from '../utils/reloadFile';
import { forgetSection, getExpandedEntry } from './expandedRegistry';
import { CollapseSection, CollapsedElement } from '../model/types';

// Types we absorb when drawn or dragged onto an expanded section (strokes /
// text / geometry / links). A link's member strokes and its link element are
// both absorbable here; resolveLinkMemberIndices (below) stitches them back
// together, or drops the link alone if not all its members made it in.
const ABSORBABLE_TYPES = new Set<number>([
  ELEMENT_TYPES.STROKE,
  ELEMENT_TYPES.TEXT,
  ELEMENT_TYPES.TEXT_DIGEST_QUOTE,
  ELEMENT_TYPES.TEXT_DIGEST_CREATE,
  ELEMENT_TYPES.GEO,
  ELEMENT_TYPES.LINK,
]);

// Recollapse ONE section from a pre-fetched element list `all`: re-serialize its
// on-page parts back into the icon's userData and delete the parts/masks. Does
// NOT saveCurrentNote / dismiss the lasso — recollapseSections batches those.
// Returns false if skipped (payload over the size cap).
async function recollapseOne(
  section: CollapseSection,
  iconElement: any,
  all: any[],
  filePath: string,
  page: number,
  pageSize: { width: number; height: number },
): Promise<boolean> {
  const classify = (elements: any[]) => {
    const masks: any[] = [];
    const parts: any[] = [];
    for (const el of elements) {
      const ud = readUserData(el);
      if (!ud) continue;
      if ((ud.kind === 'mask' || ud.kind === 'frame') && ud.id === section.id) masks.push(el);
      else if (ud.kind === 'part' && ud.id === section.id) parts.push(el);
    }
    return { masks, parts };
  };

  let { masks: maskEls, parts: partEls } = classify(all);

  // B-018: an expanded section should always have at least a mask/frame on
  // the page — finding literally nothing tagged for it is a strong signal
  // the element list this was called with (often the "fast path"'s narrower
  // candidate scan) is stale/incomplete, not that there's genuinely nothing
  // to recollapse. Confirmed on-device: this exact case silently no-ops
  // (icon glyph unchanged, nothing deleted, no error) without this check.
  // Re-fetch the whole page fresh before accepting "nothing found".
  if (maskEls.length === 0 && partEls.length === 0) {
    console.error(`${LOG} recollapse: no tagged elements found for id=${section.id} in the given list (${all.length} el) — re-fetching full page`);
    await reloadFileWithTimeout(); // B-018: without this, this read can miss a recent write too
    const freshRes: any = await PluginFileAPI.getElements(page, filePath);
    const fresh: any[] = freshRes?.success && Array.isArray(freshRes.result) ? freshRes.result : [];
    const reclassified = classify(fresh);
    maskEls = reclassified.masks;
    partEls = reclassified.parts;
    if (maskEls.length === 0 && partEls.length === 0) {
      // Genuinely nothing on the page for this section, even after a fresh
      // full read. Falling through here would build and write an EMPTY
      // collapsedElements backup — permanently losing whatever this
      // section's content actually was. Nothing has been touched yet
      // (no delete, no write), so abort cleanly instead: the icon and the
      // page are exactly as they were, and the existing backup (if any) is
      // untouched.
      console.error(`${LOG} recollapse: still nothing tagged for id=${section.id} after a full re-fetch — aborting, nothing changed`);
      await alertOverBusyView('recollapse', "This section's content couldn't be found on the page — nothing was changed. If this keeps happening, please report it.");
      return false;
    }
    all = fresh; // absorb-scan below also needs the fresh list
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

  newCollapsed = await resolveLinkMemberIndices(newCollapsed);

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
  let contentShift: CollapseSection['contentShift'];
  if (bbox) {
    const { zone, shiftDx, shiftDy } = stretchZoneToIcon(bbox, ZONE_MARGIN, iconNow);
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
    // The zone had to move to stop covering the icon — carry the same
    // rigid shift over to the actual content strokes at the next Expand
    // (not the icon-relative position, which isn't meaningful here; see
    // CollapseSection.contentShift).
    if (shiftDx || shiftDy) contentShift = { dx: shiftDx, dy: shiftDy };
  }

  // Drop preservedNums — only meaningful while expanded. contentShift is
  // always explicitly set (to a value or undefined) so a stale one from a
  // prior recollapse never leaks forward via the spread below.
  const updatedSection: CollapseSection = {
    ...section,
    collapsedElements: newCollapsed,
    iconRect,
    relativeRect,
    isExpanded: false,
    preservedNums: undefined,
    contentShift,
  };

  const payload = CE_PLUG_PREFIX + JSON.stringify(updatedSection);
  dlog(`${LOG} SIZE recollapse payload=${payload.length} bytes for ${newCollapsed.length} element(s)`);
  if (payload.length > MAX_USERDATA_BYTES) {
    await alertOverBusyView('recollapse', 'Content too large to re-collapse. Remove some content from this section.');
    return false;
  }

  // CRASH-SAFETY: write the updated section (parts + absorbed strokes,
  // re-anchored) into the icon's userData BEFORE deleting the on-page parts.
  // While expanded, those on-page parts are the only durable copy; writing the
  // icon first means a crash between write and delete leaves both copies present
  // (recoverable), never neither. iconElement comes from the page-wide
  // getElements snapshot (fresh, and its num is stable across the delete below),
  // so writeSection can skip re-reading.
  // Flip the icon's glyph back — set on the same object writeSection
  // targets, so it rides along in the same modifyElements call.
  if (iconElement?.textBox) iconElement.textBox.textContentFull = ICON_GLYPH;

  const tWrite = Date.now();
  const { ok, unstableNote } = await writeSection(filePath, page, iconElement, updatedSection, iconElement);
  dlog(`${LOG} PERF recollapse writeSection=${Date.now() - tWrite}ms`);
  if (!ok) {
    // userData not updated — leave the on-page parts in place, they're still
    // the only durable copy.
    console.error(`${LOG} failed to update section userData after recollapse — leaving on-page parts in place`);
    if (!unstableNote) await alertOverBusyView('recollapse', "Supernote couldn't complete the recollapse — please try again.");
    return false;
  }

  // Content now durable in the icon. Delete parts + absorbed + mask rings (REAL
  // file — already visible without an explicit reload on this SDK build, see
  // BUGS/B-017.md). No saveCurrentNote — it would push the stale cached copy
  // back over the deletion.
  // B-018: deleteElements can silently apply to only SOME of a multi-target
  // call (confirmed: recollapsing a section with a stroke link left the
  // link's own member strokes + mask/frame behind while everything else in
  // the same call was removed, with the call still reporting success) — the
  // same "aggregate success doesn't mean every target landed" class of bug
  // CR-004 found in batchUpdatePageElements. Don't trust the flag: re-read
  // and retry whatever's still actually there.
  const numsToDelete = Array.from(numSet);
  if (numsToDelete.length > 0) {
    let remaining: number[] = numsToDelete;
    for (let attempt = 0; attempt < 3 && remaining.length > 0; attempt++) {
      const tDel = Date.now();
      const delRes: any = await PluginFileAPI.deleteElements(filePath, page, remaining);
      dlog(`${LOG} PERF recollapse deleteElements[${attempt}]=${Date.now() - tDel}ms n=${remaining.length}`);
      if (!delRes?.success && isUnstableNoteError(delRes)) break; // note not stable — retrying won't help
      await reloadFileWithTimeout(); // B-018: without this, this read can miss the delete having just landed
      const chkRes: any = await PluginFileAPI.getElements(page, filePath);
      const chk: any[] = chkRes?.success && Array.isArray(chkRes.result) ? chkRes.result : [];
      const stillThere = new Set(chk.map((e) => e.numInPage));
      remaining = remaining.filter((n) => stillThere.has(n));
      if (remaining.length > 0) console.error(`${LOG} recollapse deleteElements attempt ${attempt} left ${remaining.length} element(s) behind: ${JSON.stringify(remaining)}`);
    }
    if (remaining.length > 0) {
      console.error(`${LOG} recollapse deleteElements: ${remaining.length} element(s) never removed after retries: ${JSON.stringify(remaining)}`);
      await alertOverBusyView('recollapse', 'Recollapsed, but some leftover elements could not be removed — please retry.');
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
  if (ud?.kind !== 'plug') return null;

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

// Recollapse one or more sections in a single pass: flush, read the section's
// elements (fast path, or a full getElements), mutate, then dismiss the lasso
// once.
export async function recollapseSections(
  sectionIds: string[],
  filePath: string,
  page: number,
): Promise<void> {
  if (sectionIds.length === 0) return;

  const permitted = await ensureAllPermissions(
    'Collapse/Expand needs permission to read and change the page to recollapse this section.',
  );
  if (!permitted) return;

  // Flush in-flight edits so the read sees strokes drawn while expanded.
  const tSave = Date.now();
  await PluginNoteAPI.saveCurrentNote();
  dlog(`${LOG} PERF recollapse saveCurrentNote=${Date.now() - tSave}ms`);

  const pageSize = await getPageSize(filePath, page);

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
      if (ud?.kind === 'plug' && ud.section?.id) iconById.set(ud.section.id, el);
    }

    for (const id of sectionIds) {
      const icon = iconById.get(id);
      const ud = icon ? readUserData(icon) : null;
      if (!icon || ud?.kind !== 'plug') {
        console.error(`${LOG} recollapse: no section icon for id=${id} (orphaned content?) — skipping`);
        continue;
      }
      await recollapseOne(ud.section, icon, all, filePath, page, pageSize);
      forgetSection(id); // no longer expanded — stop live-redrawing its box
    }
  }

  // Dismiss the lasso last — the writes are already visible without an
  // explicit reload on this SDK build (see BUGS/B-017.md).
  await dismissLassoAfterDelete('recollapse');
  // B-017: reloadFile() removed — see collapseAction.ts's identical comment
  // and BUGS/B-017.md. Terminal call here too, nothing reads afterward.
  const tReload = Date.now();
  dlog(`${LOG} PERF recollapse reload=${Date.now() - tReload}ms`);
}
