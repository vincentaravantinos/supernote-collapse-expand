import { PluginCommAPI, PluginNoteAPI } from 'sn-plugin-lib';
import { restoreElement } from '../utils/elementSerializer';
import { writeUserData } from '../utils/userDataManager';
import { CollapseSection, CollapsedElement } from '../model/types';
import { serializeElement } from '../utils/elementSerializer';
import { ELEMENT_TYPES, MAX_USERDATA_BYTES } from '../constants';
import { getRectPoints, DASHED_PEN_TYPE, BORDER_PEN_WIDTH, BORDER_PEN_COLOR } from '../utils/geometryHelpers';

export async function expandAction(section: CollapseSection, iconElementUuid: string) {
  // 2. Get current icon position
  const lassoRes = await PluginCommAPI.getLassoRect();
  if (!lassoRes.success || !lassoRes.result) {
    alert("Please select the icon or border");
    return;
  }

  // If we came from a border, we might need to find the icon's current rect.
  // For now, assume the lasso contains the icon or the border which gives us a reference.
  const currentIconOrigin = { x: lassoRes.result.left, y: lassoRes.result.top };

  // 3. Compute translation delta
  const dx = currentIconOrigin.x - section.originalIconOrigin.x;
  const dy = currentIconOrigin.y - section.originalIconOrigin.y;

  // 4. Compute actual content rect
  const actualRect = {
    left:   currentIconOrigin.x + section.relativeRect.left,
    top:    currentIconOrigin.y + section.relativeRect.top,
    right:  currentIconOrigin.x + section.relativeRect.left + section.relativeRect.width,
    bottom: currentIconOrigin.y + section.relativeRect.top  + section.relativeRect.height
  };

  // 5. Save overlap elements
  await PluginCommAPI.lassoElements(actualRect);
  const elementsRes = await PluginCommAPI.getLassoElements();
  const overlapElements: CollapsedElement[] = [];

  if (elementsRes.success && elementsRes.result) {
    for (const el of elementsRes.result) {
      if (el.type === ELEMENT_TYPES.PICTURE || el.uuid === iconElementUuid || el.userData?.startsWith('CE_PLUG:')) {
        el.recycle();
        continue;
      }
      const serialized = serializeElement(el);
      if (serialized) {
        overlapElements.push(serialized);
      }
      el.recycle();
    }
  }

  if (overlapElements.length > 0) {
    section.overlapElements = overlapElements;
    // Delete them
    for (const ce of overlapElements) {
      await PluginNoteAPI.deleteElement(ce.uuid);
    }
  } else {
    section.overlapElements = null;
  }

  // 6. Restore original elements
  const sortedElements = [...section.collapsedElements].sort((a, b) => a.numInPage - b.numInPage);
  for (const ce of sortedElements) {
    await restoreElement(ce, dx, dy);
  }

  // 7. Insert dashed border
  const borderRes = await PluginNoteAPI.insertGeometry({
    type: 'GEO_polygon',
    points: getRectPoints(actualRect),
    penColor: BORDER_PEN_COLOR,
    penWidth: BORDER_PEN_WIDTH,
    penType: DASHED_PEN_TYPE,
  });

  if (borderRes.success) {
    // 8. Locate border and write userData
    await PluginCommAPI.lassoElements(actualRect);
    const newElementsRes = await PluginCommAPI.getLassoElements();
    const borderElement = newElementsRes.result.find((el: any) => el.type === ELEMENT_TYPES.GEO && !el.userData?.startsWith('CE_PLUG:'));

    if (borderElement) {
      section.borderElementUuid = borderElement.uuid;
      await writeUserData(borderElement, { type: 'collapseExpandBorder', iconElementUuid });
      borderElement.recycle();
    }
  }

  // 9. Update icon element
  section.isExpanded = true;
  section.originalIconOrigin = currentIconOrigin;

  // Re-find the icon element to update its userData
  // We can't rely on the old reference if reload wasn't called, but we have its UUID.
  await PluginNoteAPI.setElementUserData(iconElementUuid, 'CE_PLUG:' + JSON.stringify(section));

  await PluginCommAPI.reloadFile();
}
