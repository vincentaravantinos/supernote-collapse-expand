import { PluginCommAPI, PluginFileAPI, PluginNoteAPI, Rect } from 'sn-plugin-lib';
import {
  CE_PLUG_PREFIX,
  ELEMENT_TYPES,
  ICON_FONT_SIZE,
  ICON_GLYPH,
  ICON_SIZE,
  LOG,
  MAX_USERDATA_BYTES,
  SCHEMA_VERSION,
} from '../constants';
import { serializeElement } from '../utils/elementSerializer';
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

  const collapsed: CollapsedElement[] = [];
  const tSer = Date.now();
  for (const el of elements) {
    if (el.type === ELEMENT_TYPES.PICTURE) continue;
    if (el.type === ELEMENT_TYPES.TITLE) continue;
    // Skip our own section icons.
    if (readUserData(el)?.kind === 'section') continue;
    const data = await serializeElement(el);
    if (data) {
      collapsed.push({ numInPage: el.numInPage, data });
    }
  }

  console.log(`${LOG} PERF collapse serialize=${Date.now() - tSer}ms for ${collapsed.length} element(s)`);
  if (collapsed.length === 0) {
    alert('Nothing collapsable in selection.');
    return;
  }

  const iconLeft = Math.round(lasso.left);
  const iconTop = Math.round(lasso.top);
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
      left: 0,
      top: 0,
      width: Math.round(lasso.right - lasso.left),
      height: Math.round(lasso.bottom - lasso.top),
    },
    collapsedElements: collapsed,
    isExpanded: false,
  };

  const payload = CE_PLUG_PREFIX + JSON.stringify(section);
  console.log(`${LOG} SIZE collapse payload=${payload.length} bytes for ${collapsed.length} element(s)`);
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
  console.log(`${LOG} PERF collapse deleteLasso=${Date.now() - tDel}ms`);

  const tSave = Date.now();
  await PluginNoteAPI.saveCurrentNote();
  console.log(`${LOG} PERF collapse saveCurrentNote=${Date.now() - tSave}ms`);
  const tIns = Date.now();

  // VALIDATION STEP: create the icon as a TEXT element (⊕) instead of a
  // picture, to dodge the entire class of picture-element SDK bugs (phantom
  // picturePath/1211, shrink-on-move) and test whether text inserts also
  // dodge the insert-desync blocker. Explicit styling keeps the glyph from
  // adopting the user's ambient pen/text style.
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

  console.log(`${LOG} PERF collapse create+insert=${Date.now() - tIns}ms`);

  // Deliberately NO saveCurrentNote after the insert. insertElements wrote the
  // icon to the REAL note file; saving the (possibly stale) CACHED/displayed
  // copy back over it could clobber the icon. reloadFile below reloads the
  // displayed copy FROM the real file so the icon reliably appears (the SDK's
  // async real→cached sync is unreliable). See SDK_DOC.md.

  // Dismiss the selection box left by the user's lasso + deleteLassoElements
  // (audit ①). state 2 = "Completely remove" — the standard cleanup after a
  // lasso-mutating op (cf. guibor/supernote-shape-snap, which calls
  // setLassoBoxState(2) after deleteLassoElements + insert).
  const tReload = Date.now();
  await PluginCommAPI.setLassoBoxState(2);

  // Reload the displayed copy from the real file so the inserted icon appears.
  await PluginCommAPI.reloadFile();
  console.log(`${LOG} PERF collapse close+reload=${Date.now() - tReload}ms`);
}
