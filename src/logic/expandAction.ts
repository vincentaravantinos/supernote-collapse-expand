import { PluginCommAPI, PluginFileAPI, PluginNoteAPI, PointUtils, Rect } from 'sn-plugin-lib';
import { CE_PART_PREFIX, dlog, LOG } from '../constants';
import { buildElement, contentBoundingBox } from '../utils/elementSerializer';
import { getIconByNum, iconRectFromElements, readUserData, writeSection } from '../utils/userDataManager';
import { createMaskElements } from '../utils/maskHelpers';
import { rebuildStrokeLinks, strokeLinkMemberIndices } from './strokeLinkExpand';
import { noteSectionExpanded } from './expandedRegistry';
import { CollapseSection } from '../model/types';

// Expand ONE section: insert its mask + restored content (stroke links via
// rebuildStrokeLinks) and flip the icon's userData to isExpanded. Does NOT
// saveCurrentNote / setLassoBoxState / reloadFile — expandSections does those
// once around the loop so N sections cost a single refresh.
export async function expandOne(
  section: CollapseSection,
  iconElement: any,
  filePath: string,
  page: number,
  capturePreserved: boolean = false,
): Promise<void> {
  dlog(`${LOG} SIZE expand icon userData=${iconElement?.userData?.length ?? 0} bytes, collapsed=${section.collapsedElements?.length ?? 0} element(s)`);

  const tPrep = Date.now();
  // One getElements gives the icon's CURRENT rect (the lassoed element reports a
  // stale rect after a move) and, on a real expand, preservedNums = the nums of
  // every untagged element on the page now (pre-existing content). On a live
  // redraw we carry the existing preservedNums forward instead of re-capturing
  // (which would misfile the new strokes as pre-existing).
  // Fast path: fetch only the icon (one element) + the page's num list, instead
  // of marshalling every element (the full getElements is ~7x more expensive on
  // a dense page). preservedNums needs only the num SET — the untagged filter is
  // unnecessary because recollapse's own untagged-check excludes our elements, so
  // the raw num list is equivalent. Fall back to a full getElements only if the
  // icon num is stale/missing.
  const tGE = Date.now();
  let iconRectNow: any;
  let freshIconEl: any;
  let preservedNums: number[] | undefined;
  const fastIcon = await getIconByNum(filePath, page, iconElement?.numInPage, section.id);
  if (fastIcon) {
    freshIconEl = fastIcon;
    iconRectNow = fastIcon.textBox?.textRect ?? section.iconRect;
    if (capturePreserved) {
      const nlRes: any = await PluginFileAPI.getElementNumList(filePath, page);
      preservedNums = nlRes?.success && Array.isArray(nlRes.result) ? nlRes.result : [];
    } else {
      preservedNums = section.preservedNums;
    }
    dlog(`${LOG} PERF expand read(fast getElement+numList)=${Date.now() - tGE}ms preserved=${preservedNums?.length ?? 0}`);
  } else {
    const allAtExpandRes: any = await PluginFileAPI.getElements(page, filePath);
    const allAtExpand: any[] = allAtExpandRes?.success && Array.isArray(allAtExpandRes.result) ? allAtExpandRes.result : [];
    iconRectNow = iconRectFromElements(allAtExpand, section, iconElement);
    freshIconEl = allAtExpand.find((el) => {
      const ud = readUserData(el);
      return ud?.kind === 'section' && ud.section?.id === section.id;
    }) ?? iconElement;
    preservedNums = capturePreserved
      ? allAtExpand.filter((el) => readUserData(el) == null && typeof el.numInPage === 'number').map((el) => el.numInPage)
      : section.preservedNums;
    dlog(`${LOG} PERF expand read(fallback full getElements)=${Date.now() - tGE}ms total=${allAtExpand.length} el`);
  }
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
  dlog(`${LOG} PERF expand prep(iconrect+pagesize)=${Date.now() - tPrep}ms`);

  // Register for live box redraw on icon drag. Content bbox shifted by (dx, dy)
  // (the same delta strokes are built with) = its absolute on-page bbox.
  const baseBBox = contentBoundingBox(section.collapsedElements, pageSize);
  if (baseBBox) {
    noteSectionExpanded(section.id, iconRectNow, {
      left: baseBBox.left + dx,
      top: baseBBox.top + dy,
      right: baseBBox.right + dx,
      bottom: baseBBox.bottom + dy,
    });
  }

  // Stroke-link members are re-inserted out-of-band by rebuildStrokeLinks, so
  // exclude them from the main content batch here.
  const memberIndexSet = strokeLinkMemberIndices(section.collapsedElements);
  const hasStrokeLinks = section.collapsedElements.some((ce) => ce.data.kind === 'link' && ce.data.category === 1);

  const tBuild = Date.now();
  // Mask rings first so they sit below the collapsed content.
  const maskElements = await createMaskElements(contentRect, page, section.id);

  const otherElements: any[] = [];
  for (let i = 0; i < section.collapsedElements.length; i++) {
    if (memberIndexSet.has(i)) continue; // inserted by rebuildStrokeLinks
    const ce = section.collapsedElements[i];
    const el = await buildElement(ce.data, page, CE_PART_PREFIX + section.id, emrDelta, pageMaxX, pageMaxY, dx, dy);
    if (el) otherElements.push(el);
    else if (!(ce.data.kind === 'link' && ce.data.category === 1)) console.error(`${LOG} buildElement returned null for kind=${ce.data.kind}`);
  }
  dlog(`${LOG} PERF expand build=${Date.now() - tBuild}ms`);

  let insertOk = true;
  const tIns = Date.now();
  if (!hasStrokeLinks) {
    const batch = [...maskElements, ...otherElements];
    if (batch.length > 0) {
      const ins: any = await PluginFileAPI.insertElements(filePath, page, batch);
      insertOk = !!ins?.success;
      if (!insertOk) console.error(`${LOG} insertElements failed res=${JSON.stringify(ins)}`);
      for (const el of batch) { try { el.recycle?.(); } catch { /* ignore */ } }
    }
  } else {
    // rebuildStrokeLinks owns the whole insert sequence (it needs a reload per
    // link to recover the members' fresh nums).
    insertOk = await rebuildStrokeLinks({
      filePath, page, collapsedElements: section.collapsedElements,
      sectionId: section.id, emrDelta, pageMaxX, pageMaxY, dx, dy,
      maskElements, otherElements,
    });
  }
  dlog(`${LOG} PERF expand insertElements=${Date.now() - tIns}ms`);

  // No saveCurrentNote (would clobber the inserts with the stale cached copy);
  // the end-of-batch reloadFile in expandSections surfaces them. While expanded
  // the content lives on the page as CE_PART and recollapse rebuilds the payload
  // from it, so drop collapsedElements from userData — but only if the insert
  // succeeded, keeping exactly one durable copy (userData while collapsed, page
  // while expanded).
  const expandedState: CollapseSection = {
    ...section,
    isExpanded: true,
    iconRect: iconRectNow,
    collapsedElements: insertOk ? [] : section.collapsedElements,
    preservedNums,
  };

  const tWrite = Date.now();
  const ok = await writeSection(filePath, page, iconElement, expandedState, freshIconEl);
  if (!ok) console.error(`${LOG} failed to update section userData after expand`);
  dlog(`${LOG} PERF expand writeSection=${Date.now() - tWrite}ms`);
}

// Expand one or more sections in a single screen refresh: flush + dismiss the
// lasso once, expand each, then one reloadFile. (A stroke-link section adds its
// own internal reloads; see rebuildStrokeLinks.) Loose strokes in the selection
// are left untouched.
export async function expandSections(
  targets: { section: CollapseSection; icon: any }[],
  filePath: string,
  page: number,
): Promise<void> {
  if (targets.length === 0) return;

  // Flush in-flight edits so the per-section icon-rect reads see current state.
  await PluginNoteAPI.saveCurrentNote();
  // Dismiss the lasso before any insert, so we never mutate with a lifted
  // selection (this also returns loose selected strokes to the page unchanged).
  await PluginCommAPI.setLassoBoxState(2);

  for (const t of targets) {
    await expandOne(t.section, t.icon, filePath, page, true); // capture preservedNums
  }

  const tReload = Date.now();
  await PluginCommAPI.reloadFile();
  dlog(`${LOG} PERF expand reload=${Date.now() - tReload}ms`);
}
