import { PluginCommAPI, PluginFileAPI, PluginNoteAPI, Rect } from 'sn-plugin-lib';
import {
  CE_PLUG_PREFIX,
  dlog,
  ELEMENT_TYPES,
  ICON_FONT_SIZE,
  ICON_GLYPH,
  ICON_SIZE,
  LOG,
  MAX_USERDATA_BYTES,
  SCHEMA_VERSION,
  ZONE_MARGIN,
} from '../constants';
import { contentBoundingBox, getPageSize, resolveLinkMemberIndices, serializeElement } from '../utils/elementSerializer';
import { isUnstableNoteError, readUserData } from '../utils/userDataManager';
import { ensureAllPermissions } from '../utils/permissions';
import { dismissLassoAfterDelete } from '../utils/lassoHelpers';
import { alertOverBusyView } from '../utils/busyView';
import { reloadFileWithTimeout } from '../utils/reloadFile';
import { CollapseSection, CollapsedElement } from '../model/types';

function generateSectionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function collapseAction(filePath: string, page: number, elements: any[]) {
  const lassoRes: any = await PluginCommAPI.getLassoRect();
  if (!lassoRes?.success || !lassoRes.result) {
    await alertOverBusyView('collapse', 'Please make a selection first.');
    return;
  }
  const lasso = lassoRes.result;

  const permitted = await ensureAllPermissions(
    'Collapse/Expand needs permission to read and change the page to collapse this selection.',
  );
  if (!permitted) return;

  let collapsed: CollapsedElement[] = [];
  const tSer = Date.now();
  for (const el of elements) {
    if (el.type === ELEMENT_TYPES.PICTURE) continue;
    if (el.type === ELEMENT_TYPES.TITLE) continue;
    if (readUserData(el)) continue; // any of our own tagged elements (icon, name, ...)
    const data = await serializeElement(el);
    if (data) {
      collapsed.push({ numInPage: el.numInPage, data });
    }
  }

  dlog(`${LOG} PERF collapse serialize=${Date.now() - tSer}ms for ${collapsed.length} element(s)`);

  collapsed = await resolveLinkMemberIndices(collapsed);

  if (collapsed.length === 0) {
    await alertOverBusyView('collapse', 'Nothing collapsable in selection.');
    return;
  }

  // Zone = content bbox + margin (not the lasso rect), so the mask and outline
  // hug the actual strokes. Fall back to the lasso rect if the bbox is empty.
  const pageSize = await getPageSize(filePath, page);
  const bbox = contentBoundingBox(collapsed, pageSize);
  const zone: Rect = bbox
    ? { left: bbox.left - ZONE_MARGIN, top: bbox.top - ZONE_MARGIN, right: bbox.right + ZONE_MARGIN, bottom: bbox.bottom + ZONE_MARGIN }
    : { left: Math.round(lasso.left), top: Math.round(lasso.top), right: Math.round(lasso.right), bottom: Math.round(lasso.bottom) };

  // Place the icon above-left of the zone so it clears the mask/outline and
  // stays selectable. Offset = half an icon (centers it on the zone corner) plus
  // a third for clearance; relativeRect compensates. Clamp at the page edge.
  const ICON_OFFSET = Math.round(ICON_SIZE / 2 + ICON_SIZE / 3);
  const zoneLeft = zone.left;
  const zoneTop = zone.top;
  const iconLeft = Math.max(0, zoneLeft - ICON_OFFSET);
  const iconTop = Math.max(0, zoneTop - ICON_OFFSET);
  const iconRect: Rect = {
    left: iconLeft,
    top: iconTop,
    right: iconLeft + ICON_SIZE,
    bottom: iconTop + ICON_SIZE,
  };

  const section: CollapseSection = {
    schemaVersion: SCHEMA_VERSION,
    id: generateSectionId(),
    iconRect,
    relativeRect: {
      // Offset from the icon's top-left to the zone's top-left.
      left: zoneLeft - iconLeft,
      top: zoneTop - iconTop,
      width: zone.right - zone.left,
      height: zone.bottom - zone.top,
    },
    collapsedElements: collapsed,
    isExpanded: false,
  };

  const payload = CE_PLUG_PREFIX + JSON.stringify(section);
  dlog(`${LOG} SIZE collapse payload=${payload.length} bytes for ${collapsed.length} element(s)`);
  if (payload.length > MAX_USERDATA_BYTES) {
    await alertOverBusyView('collapse', 'Selection too large to collapse. Pick a smaller area.');
    return;
  }

  // Page nums of exactly the elements we serialized — what we'll remove from the
  // page. Pictures/titles were skipped above, so they're NOT here and stay put.
  const originalNums = collapsed
    .map((ce) => ce.numInPage)
    .filter((n): n is number => typeof n === 'number');

  // Flush in-flight edits before mutating.
  const tSave = Date.now();
  await PluginNoteAPI.saveCurrentNote();
  dlog(`${LOG} PERF collapse saveCurrentNote=${Date.now() - tSave}ms`);

  // CRASH-SAFETY: insert the icon — which carries the full serialized content in
  // its userData — BEFORE deleting the originals. Until the icon is durably on the
  // page, the content exists only in JS memory, so deleting first would lose it on
  // a crash. With this order, a crash between insert and delete leaves icon + the
  // originals both present (recoverable), never nothing.
  const tIns = Date.now();
  // Icon is a TEXT element (⊕); see ICON_GLYPH. Explicit styling keeps the glyph
  // from adopting the user's ambient pen/text style.
  const createRes: any = await PluginCommAPI.createElement(ELEMENT_TYPES.TEXT);
  if (!createRes?.success || !createRes.result) {
    console.error(`${LOG} createElement failed res=${JSON.stringify(createRes)}`);
    if (!isUnstableNoteError(createRes)) await alertOverBusyView('collapse', 'Failed to create icon element.');
    return;
  }
  const iconEl: any = createRes.result;
  iconEl.textBox = {
    fontSize: ICON_FONT_SIZE,
    textContentFull: ICON_GLYPH,
    textRect: iconRect,
    textAlign: 0,
    textBold: 0,
    textItalics: 0,
    textFrameWidthType: 0,
    textFrameStyle: 0,
    textEditable: 0,
  };
  iconEl.userData = payload;
  iconEl.pageNum = page;

  // B-018: insertElements can report success without the element actually
  // landing (same bug class confirmed for deleteElements/modifyElements —
  // see CORNER_CASES.md). This is the single highest-stakes write in the
  // whole plugin: it's the only backup of the original content, and the
  // very next step deletes that content from the page. Don't trust the
  // flag — verify the icon is actually there before proceeding, retrying
  // the insert (up to 3 attempts) if not.
  let insertRes: any;
  let iconLanded = false;
  for (let attempt = 0; attempt < 3 && !iconLanded; attempt++) {
    insertRes = await PluginFileAPI.insertElements(filePath, page, [iconEl]);
    if (!insertRes?.success) {
      console.error(`${LOG} insertElements failed res=${JSON.stringify(insertRes)}`);
      if (isUnstableNoteError(insertRes)) break; // note not stable — retrying won't help
      continue;
    }
    await reloadFileWithTimeout(); // B-018: without this, the read below can miss a just-landed insert
    const checkRes: any = await PluginFileAPI.getElements(page, filePath);
    const check: any[] = checkRes?.success && Array.isArray(checkRes.result) ? checkRes.result : [];
    iconLanded = check.some((el) => el.userData === payload);
    if (!iconLanded) console.error(`${LOG} collapse: icon insert reported success but wasn't found on re-read (attempt ${attempt}) — retrying`);
  }
  if (!iconLanded) {
    // Nothing deleted yet — the page is exactly as it was, no data lost.
    if (!isUnstableNoteError(insertRes)) await alertOverBusyView('collapse', "Supernote couldn't complete the collapse — please try again.");
    try { iconEl.recycle?.(); } catch { /* ignore */ }
    return;
  }
  dlog(`${LOG} PERF collapse create+insert=${Date.now() - tIns}ms`);

  // Content is now durable in the icon. Remove the originals by num — NOT
  // deleteLassoElements, which would also delete the pictures/titles we
  // deliberately leave in place.
  const tDel = Date.now();
  if (originalNums.length > 0) {
    const delRes: any = await PluginFileAPI.deleteElements(filePath, page, originalNums);
    if (!delRes?.success) {
      console.error(`${LOG} collapse deleteElements failed res=${JSON.stringify(delRes)}`);
      if (!isUnstableNoteError(delRes)) await alertOverBusyView('collapse', "Collapsed, but the original content couldn't be removed — please retry.");
    }
  }
  dlog(`${LOG} PERF collapse delete=${Date.now() - tDel}ms`);

  // No saveCurrentNote after the writes (it would push the stale cached copy back
  // over them). Dismiss the lasso — the writes are already visible without an
  // explicit reload on this SDK build (see BUGS/B-017.md).
  const tReload = Date.now();
  await dismissLassoAfterDelete('collapse');
  // B-017: PluginCommAPI.reloadFile() can hang indefinitely on this SDK
  // build, and testing confirmed it's no longer needed here — the page
  // renders correctly without it (nothing reads back afterward in this
  // function). See BUGS/B-017.md.
  dlog(`${LOG} PERF collapse close+reload=${Date.now() - tReload}ms`);
}
