import { PluginCommAPI, PluginFileAPI, PluginManager, PluginNoteAPI } from 'sn-plugin-lib';
import {
  CE_PLUG_PREFIX,
  DEFAULT_ICON_FILENAME,
  ELEMENT_TYPES,
  ICON_SIZE,
  LOG,
  MAX_USERDATA_BYTES,
  SCHEMA_VERSION,
} from '../constants';
import { serializeElement } from '../utils/elementSerializer';
import { Rect } from 'sn-plugin-lib';
import { CollapseSection, CollapsedElement } from '../model/types';

export async function collapseAction(filePath: string, page: number, elements: any[]) {
  const lassoRes: any = await PluginCommAPI.getLassoRect();
  if (!lassoRes?.success || !lassoRes.result) {
    alert('Please make a selection first.');
    return;
  }
  const lasso = lassoRes.result;
  console.log(`${LOG} collapse lassoRect=${JSON.stringify(lasso)}`);

  const collapsed: CollapsedElement[] = [];
  let skippedPicture = false;
  for (const el of elements) {
    if (el.type === ELEMENT_TYPES.PICTURE) { skippedPicture = true; continue; }
    if (el.type === ELEMENT_TYPES.TITLE) continue;
    const data = await serializeElement(el);
    if (data) {
      collapsed.push({ numInPage: el.numInPage, data });
    }
  }

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
    iconRect,
    relativeRect: {
      left: 0,
      top: Math.round(lasso.top) - iconTop,
      width: Math.round(lasso.right - lasso.left),
      height: Math.round(lasso.bottom - lasso.top),
    },
    collapsedElements: collapsed,
    isExpanded: false,
  };

  const payload = CE_PLUG_PREFIX + JSON.stringify(section);
  if (payload.length > MAX_USERDATA_BYTES) {
    alert('Selection too large to collapse. Pick a smaller area.');
    return;
  }

  const delRes: any = await PluginCommAPI.deleteLassoElements();
  if (!delRes?.success) {
    console.error(`${LOG} deleteLassoElements failed`);
    alert('Failed to remove selected content.');
    return;
  }

  //await PluginNoteAPI.saveCurrentNote();

  const pluginDir = await PluginManager.getPluginDirPath();
  if (!pluginDir) {
    console.error(`${LOG} getPluginDirPath returned empty`);
    alert('Unable to resolve plugin icon path.');
    return;
  }
  const iconAbsPath = `${pluginDir}/${DEFAULT_ICON_FILENAME}`;

  const numsRes: any = await PluginFileAPI.getElementNumList(filePath, page);
  const existingNums: number[] = numsRes?.success ? (numsRes.result ?? []) : [];
  const nextNum = existingNums.length > 0 ? Math.max(...existingNums) + 1 : 0;

  const createRes: any = await PluginCommAPI.createElement(ELEMENT_TYPES.PICTURE);
  if (!createRes?.success || !createRes.result) {
    console.error(`${LOG} createElement failed res=${JSON.stringify(createRes)}`);
    alert('Failed to create icon element.');
    return;
  }
  const iconEl: any = createRes.result;
  iconEl.picture = { picturePath: iconAbsPath, rect: iconRect };
  iconEl.userData = payload;
  iconEl.pageNum = page;
  iconEl.numInPage = nextNum;

  const insertRes: any = await PluginFileAPI.insertElements(filePath, page, [iconEl]);
  if (!insertRes?.success) {
    console.error(`${LOG} insertElements failed res=${JSON.stringify(insertRes)}`);
    alert('Failed to insert icon.');
    try { iconEl.recycle?.(); } catch { /* ignore */ }
    return;
  }

  //try { iconEl.recycle?.(); } catch { /* ignore */ }

  if (skippedPicture) {
    console.log(`${LOG} skipped picture elements in selection`);
  }

  await PluginCommAPI.reloadFile();
}
