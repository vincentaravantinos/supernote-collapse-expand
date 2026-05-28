import { PluginCommAPI, PluginFileAPI, PluginManager, PluginNoteAPI, Rect } from 'sn-plugin-lib';
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

  await PluginNoteAPI.saveCurrentNote();

  // Resolve the bundled icon's on-device path. The build copies
  // DEFAULT_ICON_FILENAME to the plugin package root, so it lives directly
  // under the plugin install directory at runtime.
  const dirRes: any = await PluginManager.getPluginDirPath();
  const pluginDir: string | null =
    typeof dirRes === 'string' ? dirRes : (dirRes?.result ?? null);
  if (typeof pluginDir !== 'string' || pluginDir.length === 0) {
    console.error(`${LOG} getPluginDirPath returned ${JSON.stringify(dirRes)}`);
    alert('Failed to locate plugin icon.');
    return;
  }
  const picturePath = `${pluginDir.replace(/\/+$/, '')}/${DEFAULT_ICON_FILENAME}`;

  const createRes: any = await PluginCommAPI.createElement(ELEMENT_TYPES.PICTURE);
  if (!createRes?.success || !createRes.result) {
    console.error(`${LOG} createElement failed res=${JSON.stringify(createRes)}`);
    alert('Failed to create icon element.');
    return;
  }
  const iconEl: any = createRes.result;
  iconEl.picture = {
    picturePath,
    rect: iconRect,
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

  await PluginNoteAPI.saveCurrentNote();
}
