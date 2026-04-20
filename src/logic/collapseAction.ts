import { PluginCommAPI, PluginNoteAPI, PluginManager } from 'sn-plugin-lib';
import { ICON_SIZE, DEFAULT_ICON_PATH, ELEMENT_TYPES, MAX_USERDATA_BYTES } from '../constants';
import { serializeElement } from '../utils/elementSerializer';
import { writeUserData } from '../utils/userDataManager';
import { CollapseSection } from '../model/types';

export async function collapseAction() {
  // 1. Show "Processing…" indicator
  // Note: SDK usually has a way to show a toast or loading.
  // We'll use PluginCommAPI.showToast if available.

  const lassoRes = await PluginCommAPI.getLassoRect();
  if (!lassoRes.success || !lassoRes.result) {
    alert("Please make a selection first");
    return;
  }
  const rect = lassoRes.result;

  const elementsRes = await PluginCommAPI.getLassoElements();
  if (!elementsRes.success || !elementsRes.result || elementsRes.result.length === 0) {
    alert("Nothing collapsable in selection");
    return;
  }

  const elements = elementsRes.result;
  const collapsableElements = [];
  let containsPicture = false;

  for (const el of elements) {
    if (el.type === ELEMENT_TYPES.PICTURE) {
      containsPicture = true;
      el.recycle();
      continue;
    }
    if (el.type === ELEMENT_TYPES.TITLE) {
      el.recycle();
      continue;
    }

    const serialized = serializeElement(el);
    if (serialized) {
      collapsableElements.push(serialized);
    }
    el.recycle();
  }

  if (containsPicture) {
    // alert("Pictures cannot be collapsed and will remain visible");
  }

  if (collapsableElements.length === 0) {
    alert("Nothing collapsable in selection");
    return;
  }

  const iconOrigin = { x: rect.left, y: rect.top };
  const section: CollapseSection = {
    schemaVersion: 1,
    originalIconOrigin: iconOrigin,
    relativeRect: {
      left: 0,
      top: ICON_SIZE + 4,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top
    },
    collapsedElements: collapsableElements,
    overlapElements: null,
    isExpanded: false,
    borderElementUuid: null
  };

  const userDataString = 'CE_PLUG:' + JSON.stringify(section);
  if (userDataString.length > MAX_USERDATA_BYTES) {
    alert("This selection is too large to collapse. Please select a smaller area.");
    return;
  }

  // 7. Delete the collapsable elements
  // Use deleteByUuid if available, or deleteLassoElements (careful with pictures)
  // For simplicity, we assume we want to delete what we serialized.
  for (const ce of collapsableElements) {
    await PluginNoteAPI.deleteElement(ce.uuid);
  }

  // 8. Insert the "+" icon image
  const insertRes = await PluginNoteAPI.insertPicture({
    path: DEFAULT_ICON_PATH,
    rect: {
      left: iconOrigin.x,
      top: iconOrigin.y,
      right: iconOrigin.x + ICON_SIZE,
      bottom: iconOrigin.y + ICON_SIZE
    }
  });

  if (!insertRes.success) {
    alert("Failed to insert icon");
    return;
  }

  // 9. Locate the newly inserted icon element
  await PluginCommAPI.lassoElements({
    left: iconOrigin.x - 2,
    top: iconOrigin.y - 2,
    right: iconOrigin.x + ICON_SIZE + 2,
    bottom: iconOrigin.y + ICON_SIZE + 2
  });

  const newElementsRes = await PluginCommAPI.getLassoElements();
  const iconElement = newElementsRes.result.find((el: any) => el.type === ELEMENT_TYPES.PICTURE && !el.userData?.startsWith('CE_PLUG:'));

  if (iconElement) {
    await writeUserData(iconElement, section);
    iconElement.recycle();
  }

  await PluginCommAPI.reloadFile();
}
