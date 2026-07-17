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
import { contentBoundingBox, resolveLinkMemberIndices, serializeElement } from '../utils/elementSerializer';
import { isUnstableNoteError, readUserData } from '../utils/userDataManager';
import { CollapseSection, CollapsedElement } from '../model/types';

function generateSectionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function collapseAction(filePath: string, page: number, elements: any[]) {
  const lassoRes: any = await PluginCommAPI.getLassoRect();
  if (!lassoRes?.success || !lassoRes.result) {
    alert('Please make a selection first.');
    return;
  }
  const lasso = lassoRes.result;

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

  collapsed = resolveLinkMemberIndices(collapsed);

  if (collapsed.length === 0) {
    alert('Nothing collapsable in selection.');
    return;
  }

  // Zone = content bbox + margin (not the lasso rect), so the mask and outline
  // hug the actual strokes. Fall back to the lasso rect if the bbox is empty.
  const sizeRes: any = await PluginFileAPI.getPageSize(filePath, page);
  const pageSize = sizeRes?.success && sizeRes.result
    ? { width: sizeRes.result.width, height: sizeRes.result.height }
    : { width: 1404, height: 1872 };
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
    alert('Selection too large to collapse. Pick a smaller area.');
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
    if (!isUnstableNoteError(createRes)) alert('Failed to create icon element.');
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

  const insertRes: any = await PluginFileAPI.insertElements(filePath, page, [iconEl]);
  if (!insertRes?.success) {
    // Nothing deleted yet — the page is exactly as it was, no data lost.
    console.error(`${LOG} insertElements failed res=${JSON.stringify(insertRes)}`);
    if (!isUnstableNoteError(insertRes)) alert("Supernote couldn't complete the collapse — please try again.");
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
      if (!isUnstableNoteError(delRes)) alert("Collapsed, but the original content couldn't be removed — please retry.");
    }
  }
  dlog(`${LOG} PERF collapse delete=${Date.now() - tDel}ms`);

  // No saveCurrentNote after the writes (it would push the stale cached copy back
  // over them). Dismiss the lasso, then reloadFile syncs cached:=real. See SDK_DOC.
  const tReload = Date.now();
  const lassoRes2: any = await PluginCommAPI.setLassoBoxState(2);
  if (!lassoRes2?.success) {
    // Error 904 here is expected, not a bug: the elements that were lassoed
    // were just deleted above, so the SDK's lasso reference is already gone —
    // nothing left to dismiss (getLassoElements fails the same way at this
    // point). Any other error is worth knowing about.
    if (lassoRes2?.error?.code === 904) {
      dlog(`${LOG} collapse setLassoBoxState res=${JSON.stringify(lassoRes2)} (expected)`);
    } else {
      console.error(`${LOG} collapse setLassoBoxState res=${JSON.stringify(lassoRes2)}`);
    }
  }
  const reloadRes: any = await PluginCommAPI.reloadFile();
  if (!reloadRes?.success) console.error(`${LOG} collapse reloadFile res=${JSON.stringify(reloadRes)}`);
  dlog(`${LOG} PERF collapse close+reload=${Date.now() - tReload}ms`);
}
