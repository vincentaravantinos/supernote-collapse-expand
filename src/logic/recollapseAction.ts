import { PluginCommAPI, PluginNoteAPI } from 'sn-plugin-lib';
import { CollapseSection } from '../model/types';
import { serializeElement, restoreElement } from '../utils/elementSerializer';
import { writeUserData } from '../utils/userDataManager';
import { ELEMENT_TYPES, MAX_USERDATA_BYTES } from '../constants';

export async function recollapseAction(section: CollapseSection, iconElementUuid: string) {
  // 2. Get current icon position and compute actualRect
  const lassoRes = await PluginCommAPI.getLassoRect();
  if (!lassoRes.success || !lassoRes.result) {
    alert("Please select the icon or border");
    return;
  }

  const currentIconOrigin = { x: lassoRes.result.left, y: lassoRes.result.top };
  let actualRect = {
    left:   currentIconOrigin.x + section.relativeRect.left,
    top:    currentIconOrigin.y + section.relativeRect.top,
    right:  currentIconOrigin.x + section.relativeRect.left + section.relativeRect.width,
    bottom: currentIconOrigin.y + section.relativeRect.top  + section.relativeRect.height
  };

  // 3. Edge case — strokes overflowing actualRect
  // Note: Scanning all elements on the page might be slow, but it's required.
  const allElementsRes = await PluginCommAPI.getAllElements();
  if (allElementsRes.success && allElementsRes.result) {
    let expanded = false;
    for (const el of allElementsRes.result) {
      // Check if first point is inside and bounding box extends outside
      // This requires bounding box info which SDK usually provides in 'rect' or 'points'
      const elRect = el.rect || { left: 0, top: 0, right: 0, bottom: 0 };
      const firstPoint = (el.points && el.points[0]) || { x: elRect.left, y: elRect.top };

      const isInside = firstPoint.x >= actualRect.left && firstPoint.x <= actualRect.right &&
                       firstPoint.y >= actualRect.top && firstPoint.y <= actualRect.bottom;

      if (isInside) {
        if (elRect.left < actualRect.left || elRect.top < actualRect.top ||
            elRect.right > actualRect.right || elRect.bottom > actualRect.bottom) {

          actualRect.left = Math.min(actualRect.left, elRect.left);
          actualRect.top = Math.min(actualRect.top, elRect.top);
          actualRect.right = Math.max(actualRect.right, elRect.right);
          actualRect.bottom = Math.max(actualRect.bottom, elRect.bottom);
          expanded = true;
        }
      }
      el.recycle();
    }

    if (expanded) {
      section.relativeRect = {
        left: actualRect.left - currentIconOrigin.x,
        top: actualRect.top - currentIconOrigin.y,
        width: actualRect.right - actualRect.left,
        height: actualRect.bottom - actualRect.top
      };
      // alert("The section boundary was expanded to include overflowing content.");
    }
  }

  // 4. Snapshot current expanded content
  await PluginCommAPI.lassoElements(actualRect);
  const elementsRes = await PluginCommAPI.getLassoElements();
  const newCollapsedElements = [];

  if (elementsRes.success && elementsRes.result) {
    const sorted = elementsRes.result.sort((a: any, b: any) => a.numInPage - b.numInPage);
    for (const el of sorted) {
      if (el.uuid === iconElementUuid || el.uuid === section.borderElementUuid) {
        el.recycle();
        continue;
      }
      const serialized = serializeElement(el);
      if (serialized) {
        newCollapsedElements.push(serialized);
      }
      el.recycle();
    }
  }

  const newUserDataString = 'CE_PLUG:' + JSON.stringify({ ...section, collapsedElements: newCollapsedElements });
  if (newUserDataString.length > MAX_USERDATA_BYTES) {
    alert("The expanded content is too large to re-collapse. Please reduce the content in this section.");
    return;
  }

  // Delete everything currently in the content area except icon/border
  for (const ce of newCollapsedElements) {
    await PluginNoteAPI.deleteElement(ce.uuid);
  }

  // 5. Delete the dashed border element
  if (section.borderElementUuid) {
    await PluginNoteAPI.deleteElement(section.borderElementUuid);
  }

  // 6. Restore overlap elements
  if (section.overlapElements) {
    const sortedOverlap = [...section.overlapElements].sort((a, b) => a.numInPage - b.numInPage);
    for (const ce of sortedOverlap) {
      await restoreElement(ce, 0, 0); // No translation, absolute coords
    }
  }

  // 7. Update icon element
  section.collapsedElements = newCollapsedElements;
  section.overlapElements = null;
  section.isExpanded = false;
  section.borderElementUuid = null;
  section.originalIconOrigin = currentIconOrigin;

  await PluginNoteAPI.setElementUserData(iconElementUuid, 'CE_PLUG:' + JSON.stringify(section));

  await PluginCommAPI.reloadFile();
}
