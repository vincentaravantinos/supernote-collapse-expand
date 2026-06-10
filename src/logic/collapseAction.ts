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
} from '../constants';
import { resolveLinkMemberIndices, serializeElement } from '../utils/elementSerializer';
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
    // Skip our own section icons.
    if (readUserData(el)?.kind === 'section') continue;
    const data = await serializeElement(el);
    if (data) {
      collapsed.push({ numInPage: el.numInPage, data });
    }
  }

  dlog(`${LOG} PERF collapse serialize=${Date.now() - tSer}ms for ${collapsed.length} element(s)`);

  // Resolve stroke links' member references: raw page nums -> stable indexes
  // into `collapsed`. Drops any stroke link whose member strokes weren't all
  // collapsed (alerts the user).
  collapsed = resolveLinkMemberIndices(collapsed);

  if (collapsed.length === 0) {
    alert('Nothing collapsable in selection.');
    return;
  }

  // Place the icon half an icon-size up and to the left of the lasso area, so
  // when the section is expanded the icon peeks out past the restored content
  // + mask and stays easy to select (instead of being covered by it).
  // relativeRect's offset compensates so the content still restores at its
  // original lasso position. Clamp at the page edge so the icon never goes
  // off-page.
  const ICON_OFFSET = Math.round(ICON_SIZE / 2);
  const lassoLeft = Math.round(lasso.left);
  const lassoTop = Math.round(lasso.top);
  const iconLeft = Math.max(0, lassoLeft - ICON_OFFSET);
  const iconTop = Math.max(0, lassoTop - ICON_OFFSET);
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
      // Offset from the icon's top-left to the content's top-left (= the icon
      // shift, or less if clamped at the edge), so contentRect lands on the
      // original lasso area.
      left: lassoLeft - iconLeft,
      top: lassoTop - iconTop,
      width: Math.round(lasso.right - lasso.left),
      height: Math.round(lasso.bottom - lasso.top),
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

  dlog(`${LOG} PERF collapse create+insert=${Date.now() - tIns}ms`);

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
  dlog(`${LOG} PERF collapse close+reload=${Date.now() - tReload}ms`);
}
