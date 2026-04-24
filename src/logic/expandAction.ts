import { PluginCommAPI, PluginFileAPI, PluginManager, PluginNoteAPI, PointUtils } from 'sn-plugin-lib';
import {
  CE_BORDER_PREFIX,
  DEFAULT_ICON_FILENAME,
  ELEMENT_TYPES,
  LOG,
} from '../constants';
import {
  buildStrokeElement,
  restoreNonStrokeElement,
  StrokeBuildContext,
} from '../utils/elementSerializer';
import { writeSection } from '../utils/userDataManager';
import {
  BORDER_PEN_COLOR,
  BORDER_PEN_TYPE,
  BORDER_PEN_WIDTH,
  getRectPoints,
} from '../utils/geometryHelpers';
import { Rect } from 'sn-plugin-lib';
import { CollapseSection } from '../model/types';

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

export async function expandAction(
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

  const dx = iconRectNow.left - section.iconRect.left;
  const dy = iconRectNow.top - section.iconRect.top;

  const sizeRes: any = await PluginFileAPI.getPageSize(filePath, page);
  const pageSize: { width: number; height: number } =
    sizeRes?.success && sizeRes.result
      ? { width: sizeRes.result.width, height: sizeRes.result.height }
      : { width: 1404, height: 1872 };

  let targetMaxX = 15819;
  let targetMaxY = 11864;
  try {
    targetMaxX = PointUtils.getRealMaxX(pageSize);
    targetMaxY = PointUtils.getRealMaxY(pageSize);
  } catch (e) {
    console.error(`${LOG} PointUtils.getRealMaxX failed pageSize=${JSON.stringify(pageSize)}`, e);
  }

  const mapX = targetMaxX / (pageSize.height - 1);
  const mapY = targetMaxY / (pageSize.width - 1);
  const dEmrX = dy * mapX;
  const dEmrY = -dx * mapY;
  const strokeCtx: StrokeBuildContext = { targetMaxX, targetMaxY, dEmrX, dEmrY };

  console.log(`${LOG} expand iconSaved=${JSON.stringify(section.iconRect)} iconNow=${JSON.stringify(iconRectNow)} dxScreen=${dx} dyScreen=${dy} pageSize=${JSON.stringify(pageSize)} target=(${targetMaxX},${targetMaxY}) dEmr=(${dEmrX.toFixed(1)},${dEmrY.toFixed(1)}) numStrokes=${section.collapsedElements.filter(c => c.data.kind === 'stroke').length}`);

  const numsRes: any = await PluginFileAPI.getElementNumList(filePath, page);
  const existingNums: number[] = numsRes?.success ? (numsRes.result ?? []) : [];
  let nextNum = existingNums.length > 0 ? Math.max(...existingNums) + 1 : 0;

  const fileElements: any[] = [];
  for (const ce of section.collapsedElements) {
    if (ce.data.kind === 'stroke') {
      const el = await buildStrokeElement(ce.data, page, strokeCtx);
      if (el) {
        el.numInPage = nextNum++;
        fileElements.push(el);
      } else {
        console.error(`${LOG} buildStrokeElement returned null`);
      }
    } else {
      const ok = await restoreNonStrokeElement(ce.data, dx, dy);
      if (!ok) console.error(`${LOG} restoreNonStrokeElement failed for kind=${ce.data.kind}`);
    }
  }

  let borderAssignedNum: number | undefined;
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
    borderEl.numInPage = nextNum++;
    borderEl.userData = CE_BORDER_PREFIX;
    borderAssignedNum = borderEl.numInPage;
    fileElements.push(borderEl);
  }

  let borderActualNum: number | undefined;
  if (fileElements.length > 0) {
    const ins: any = await PluginFileAPI.insertElements(filePath, page, fileElements);
    if (!ins?.success) {
      console.error(`${LOG} insertElements failed res=${JSON.stringify(ins)}`);
    } else {
      console.log(`${LOG} insertElements ok result=${JSON.stringify(ins.result)} count=${fileElements.length}`);
      if (borderAssignedNum !== undefined && Array.isArray(ins.result) && ins.result.length > 0) {
        const last = ins.result[ins.result.length - 1];
        borderActualNum = typeof last === 'number' ? last : borderAssignedNum;
      }
    }
    for (const el of fileElements) {
      try { el.recycle?.(); } catch { /* ignore */ }
    }
  }

  section.isExpanded = true;
  section.iconRect = iconRectNow;
  section.borderNumInPage = borderActualNum ?? borderAssignedNum;

  const pluginDir = await PluginManager.getPluginDirPath();
  if (pluginDir && iconElement?.picture) {
    iconElement.picture.picturePath = `${pluginDir}/${DEFAULT_ICON_FILENAME}`;
  }

  await PluginNoteAPI.saveCurrentNote();

  const ok = await writeSection(filePath, page, iconElement, section);
  if (!ok) console.error(`${LOG} failed to update section userData after expand`);

  await PluginCommAPI.reloadFile();
}
