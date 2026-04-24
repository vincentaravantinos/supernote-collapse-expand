import { PluginCommAPI, PluginFileAPI, PluginManager, PluginNoteAPI } from 'sn-plugin-lib';
import {
  CE_PLUG_PREFIX,
  DEFAULT_ICON_FILENAME,
  LOG,
  MAX_USERDATA_BYTES,
} from '../constants';
import { serializeElement } from '../utils/elementSerializer';
import { readUserData, writeSection } from '../utils/userDataManager';
import { CollapseSection, CollapsedElement, Rect } from '../model/types';

function currentIconRect(iconElement: any, fallback: Rect): Rect {
  const pRect = iconElement?.picture?.rect;
  if (pRect && typeof pRect.left === 'number') {
    return {
      left: Math.round(pRect.left),
      top: Math.round(pRect.top),
      right: Math.round(pRect.right),
      bottom: Math.round(pRect.bottom),
    };
  }
  return fallback;
}

export async function recollapseAction(
  section: CollapseSection,
  iconElement: any,
  filePath: string,
  page: number,
) {
  const iconRectNow = currentIconRect(iconElement, section.iconRect);

  const contentRect: Rect = {
    left: iconRectNow.left + section.relativeRect.left,
    top: iconRectNow.top + section.relativeRect.top,
    right: iconRectNow.left + section.relativeRect.left + section.relativeRect.width,
    bottom: iconRectNow.top + section.relativeRect.top + section.relativeRect.height,
  };

  // 1. Lasso the area where content was expanded
  await PluginCommAPI.lassoElements(contentRect);
  const elementsRes: any = await PluginCommAPI.getLassoElements();
  const lassoed: any[] = elementsRes?.success ? (elementsRes.result ?? []) : [];

  const newCollapsed: CollapsedElement[] = [];
  const numsToDelete: number[] = [];

  // 2. Scan lassoed elements: serialize content and collect indices for deletion
  for (const el of lassoed) {
    const ud = readUserData(el);

    // CRITICAL: Do not delete or serialize the Icon element itself
    if (ud?.kind === 'section') continue;

    // Collect indices for deletion (including the border)
    if (typeof el.numInPage === 'number') {
      numsToDelete.push(el.numInPage);
    }

    // Only serialize non-border content
    if (ud?.kind !== 'border') {
      const data = await serializeElement(el);
      if (data) {
        newCollapsed.push({ numInPage: el.numInPage, data });
      }
    }
  }

  // 3. Update section state
  const updatedSection: CollapseSection = {
    ...section,
    collapsedElements: newCollapsed,
    isExpanded: false,
    iconRect: iconRectNow,
  };

  const payload = CE_PLUG_PREFIX + JSON.stringify(updatedSection);
  if (payload.length > MAX_USERDATA_BYTES) {
    alert('Content too large to re-collapse. Remove some content from this section.');
    for (const el of lassoed) { try { el.recycle?.(); } catch { /* ignore */ } }
    return;
  }

  // 4. Perform Deletion and Commit
  if (numsToDelete.length > 0) {
    console.log(`${LOG} recollapse deleting indices: ${numsToDelete.join(', ')}`);
    const delRes: any = await PluginFileAPI.deleteElements(filePath, page, numsToDelete);
    console.log(`${LOG} deleteElements res: ${JSON.stringify(delRes)}`);

    // Commit the deletion to the note file before reload
    await PluginNoteAPI.saveCurrentNote();
  }

  // 5. Update the Icon element's userData
  // Ensure the picturePath is valid to avoid the "PNG file does not exist" error (code 1211)
  const pluginDir = await PluginManager.getPluginDirPath();
  if (pluginDir && iconElement?.picture) {
    iconElement.picture.picturePath = `${pluginDir}/${DEFAULT_ICON_FILENAME}`;
  }

  const ok = await writeSection(filePath, page, iconElement, updatedSection);
  if (!ok) {
    console.error(`${LOG} failed to update section userData after recollapse`);
  }

  // 6. Cleanup native objects
  for (const el of lassoed) {
    try { el.recycle?.(); } catch { /* ignore */ }
  }

  await PluginCommAPI.reloadFile();
}
