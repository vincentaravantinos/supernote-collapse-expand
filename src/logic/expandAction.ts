import { PluginCommAPI, PluginFileAPI, PluginNoteAPI, PointUtils, Rect } from 'sn-plugin-lib';
import {
  CE_BORDER_PREFIX,
  ELEMENT_TYPES,
  LOG,
} from '../constants';
import { buildElement } from '../utils/elementSerializer';
import { readUserData, writeSection } from '../utils/userDataManager';
import {
  BORDER_PEN_COLOR,
  BORDER_PEN_TYPE,
  BORDER_PEN_WIDTH,
  getRectPoints,
} from '../utils/geometryHelpers';
import { CollapseSection } from '../model/types';

export async function expandAction(
  section: CollapseSection,
  iconElement: any,
  filePath: string,
  page: number,
) {
  const iconRectNow = iconElement?.textBox?.textRect ?? section.iconRect;

  const contentRect: Rect = {
    left: iconRectNow.left + section.relativeRect.left,
    top: iconRectNow.top + section.relativeRect.top,
    right: iconRectNow.left + section.relativeRect.left + section.relativeRect.width,
    bottom: iconRectNow.top + section.relativeRect.top + section.relativeRect.height,
  };

  const dx = iconRectNow.left - section.iconRect.left;
  const dy = iconRectNow.top - section.iconRect.top;

  const sizeRes: any = await PluginFileAPI.getPageSize(filePath, page);
  const pageSize = sizeRes?.success && sizeRes.result
    ? { width: sizeRes.result.width, height: sizeRes.result.height }
    : { width: 1404, height: 1872 };

  const emrNow = PointUtils.androidPoint2Emr({ x: iconRectNow.left, y: iconRectNow.top }, pageSize);
  const emrSaved = PointUtils.androidPoint2Emr({ x: section.iconRect.left, y: section.iconRect.top }, pageSize);
  const emrDelta = { x: emrNow.x - emrSaved.x, y: emrNow.y - emrSaved.y };
  const pageMaxX = PointUtils.getRealMaxX(pageSize);
  const pageMaxY = PointUtils.getRealMaxY(pageSize);

  const fileElements: any[] = [];
  for (const ce of section.collapsedElements) {
    const el = await buildElement(ce.data, page, section.id, emrDelta, pageMaxX, pageMaxY, dx, dy);
    if (el) fileElements.push(el);
    else console.error(`${LOG} buildElement returned null for kind=${ce.data.kind}`);
  }

  const borderRes: any = await PluginCommAPI.createElement(ELEMENT_TYPES.GEO);
  if (!borderRes?.success || !borderRes.result) {
    console.error(`${LOG} createElement(GEO) failed res=${JSON.stringify(borderRes)}`);
  } else {
    const borderEl: any = borderRes.result;
    borderEl.geometry = {
      type: 'GEO_polygon',
      points: getRectPoints(contentRect),
      penColor: BORDER_PEN_COLOR,
      penType: BORDER_PEN_TYPE,
      penWidth: BORDER_PEN_WIDTH,
    };
    borderEl.pageNum = page;
    borderEl.userData = CE_BORDER_PREFIX + section.id;
    fileElements.push(borderEl);
  }

  if (fileElements.length > 0) {
    const ins: any = await PluginFileAPI.insertElements(filePath, page, fileElements);
    if (!ins?.success) {
      console.error(`${LOG} insertElements failed res=${JSON.stringify(ins)}`);
    }
    for (const el of fileElements) {
      try { el.recycle?.(); } catch { /* ignore */ }
    }
  }

  await PluginNoteAPI.saveCurrentNote();

  section.isExpanded = true;
  section.iconRect = iconRectNow;

  const ok = await writeSection(filePath, page, iconElement, section);
  if (!ok) console.error(`${LOG} failed to update section userData after expand`);

  await PluginCommAPI.reloadFile();
}
