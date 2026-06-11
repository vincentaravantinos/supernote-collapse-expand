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
import { readUserData } from '../utils/userDataManager';
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
    if (readUserData(el)?.kind === 'section') continue; // our own icons
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

  const tDel = Date.now();
  const delRes: any = await PluginCommAPI.deleteLassoElements();
  if (!delRes?.success) {
    console.error(`${LOG} deleteLassoElements failed`);
    alert('Failed to remove selected content.');
    return;
  }
  dlog(`${LOG} PERF collapse deleteLasso=${Date.now() - tDel}ms`);

  const tSave = Date.now();
  await PluginNoteAPI.saveCurrentNote();
  dlog(`${LOG} PERF collapse saveCurrentNote=${Date.now() - tSave}ms`);
  const tIns = Date.now();

  // Icon is a TEXT element (⊕); see ICON_GLYPH. Explicit styling keeps the glyph
  // from adopting the user's ambient pen/text style.
  const createRes: any = await PluginCommAPI.createElement(ELEMENT_TYPES.TEXT);
  if (!createRes?.success || !createRes.result) {
    console.error(`${LOG} createElement failed res=${JSON.stringify(createRes)}`);
    alert('Failed to create icon element.');
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
    console.error(`${LOG} insertElements failed res=${JSON.stringify(insertRes)}`);
    alert('Failed to insert icon.');
    try { iconEl.recycle?.(); } catch { /* ignore */ }
    return;
  }

  dlog(`${LOG} PERF collapse create+insert=${Date.now() - tIns}ms`);

  // No saveCurrentNote: insertElements wrote the icon to the REAL file, and
  // saving would push the stale cached copy back over it. reloadFile (below)
  // syncs cached:=real so the icon appears. See SDK_DOC.md.

  // Dismiss the user's lasso (state 2 = remove) before reloading.
  const tReload = Date.now();
  await PluginCommAPI.setLassoBoxState(2);
  await PluginCommAPI.reloadFile();
  dlog(`${LOG} PERF collapse close+reload=${Date.now() - tReload}ms`);
}
