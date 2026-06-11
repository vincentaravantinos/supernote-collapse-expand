import { PluginCommAPI, PluginFileAPI, PluginNoteAPI, PointUtils, Rect } from 'sn-plugin-lib';
import { CE_PART_PREFIX, dlog, LOG } from '../constants';
import { buildElement, contentBoundingBox } from '../utils/elementSerializer';
import { iconRectFromElements, readUserData, writeSection } from '../utils/userDataManager';
import { createMaskElements } from '../utils/maskHelpers';
import { rebuildStrokeLinks, strokeLinkMemberIndices } from './strokeLinkExpand';
import { noteSectionExpanded } from './expandedRegistry';
import { CollapseSection } from '../model/types';

// Expand ONE section: insert its mask + restored content (stroke links rebuilt
// via rebuildStrokeLinks) and flip the icon's userData to isExpanded.
//
// Deliberately does NOT saveCurrentNote / setLassoBoxState / reloadFile —
// expandSections does those once around the loop so N sections cost a single
// refresh. Reads only this section's own icon (resolved fresh by id), so it is
// unaffected by sibling sections inserted earlier in the same batch but not yet
// reloaded (their content carries a different CE_PART:<id> tag).
export async function expandOne(
  section: CollapseSection,
  iconElement: any,
  filePath: string,
  page: number,
  capturePreserved: boolean = false,
): Promise<void> {
  // SIZE PROBE: the round-tripped userData length read back from the icon. If
  // this is much smaller than what collapse wrote, the userData was truncated
  // (real ceiling); if it matches, big payloads survive the write/read.
  dlog(`${LOG} SIZE expand icon userData=${iconElement?.userData?.length ?? 0} bytes, collapsed=${section.collapsedElements?.length ?? 0} element(s)`);

  const tPrep = Date.now();
  // One getElements: the icon's CURRENT rect (not the lassoed element, which can
  // report a stale rect after a move) AND — on a real expand (capturePreserved) —
  // preservedNums = the nums of every UNTAGGED element on the page right now,
  // before this section's content goes on. Those are the pre-existing strokes
  // (incl. any sitting under the section); recollapse uses them to tell new
  // strokes drawn on the section apart from pre-existing content. Just nums, no
  // point-draining. On a live redraw (capturePreserved=false) we carry the
  // section's existing preservedNums forward instead of re-capturing (which would
  // misfile the new strokes as pre-existing).
  const allAtExpandRes: any = await PluginFileAPI.getElements(page, filePath);
  const allAtExpand: any[] = allAtExpandRes?.success && Array.isArray(allAtExpandRes.result) ? allAtExpandRes.result : [];
  const iconRectNow = iconRectFromElements(allAtExpand, section, iconElement);
  const preservedNums = capturePreserved
    ? allAtExpand.filter((el) => readUserData(el) == null && typeof el.numInPage === 'number').map((el) => el.numInPage)
    : section.preservedNums;
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

  // Register this section for live box redraw on icon drag. The content is laid
  // out at its serialized bbox shifted by (dx, dy) (the same delta strokes are
  // built with), giving its absolute on-page bounding box — stable while expanded
  // (only the icon moving, which is what we redraw for, changes the zone).
  const baseBBox = contentBoundingBox(section.collapsedElements, pageSize);
  if (baseBBox) {
    noteSectionExpanded(section.id, iconRectNow, {
      left: baseBBox.left + dx,
      top: baseBBox.top + dy,
      right: baseBBox.right + dx,
      bottom: baseBBox.bottom + dy,
    });
  }

  // Stroke links (category 1) are re-inserted out-of-band (their member strokes
  // get fresh page nums on re-insert), so EXCLUDE those members from the main
  // content here. Build masks and the non-member content separately.
  const memberIndexSet = strokeLinkMemberIndices(section.collapsedElements);
  const hasStrokeLinks = section.collapsedElements.some((ce) => ce.data.kind === 'link' && ce.data.category === 1);

  const tBuild = Date.now();
  // Mask rings first so they sit below the collapsed content.
  const maskElements = await createMaskElements(contentRect, page, section.id);

  const otherElements: any[] = [];
  for (let i = 0; i < section.collapsedElements.length; i++) {
    // Stroke-link members are inserted by rebuildStrokeLinks; the category-1
    // links themselves are skipped here (buildElement returns null for them).
    if (memberIndexSet.has(i)) continue;
    const ce = section.collapsedElements[i];
    const el = await buildElement(ce.data, page, CE_PART_PREFIX + section.id, emrDelta, pageMaxX, pageMaxY, dx, dy);
    if (el) otherElements.push(el);
    else if (!(ce.data.kind === 'link' && ce.data.category === 1)) console.error(`${LOG} buildElement returned null for kind=${ce.data.kind}`);
  }
  dlog(`${LOG} PERF expand build=${Date.now() - tBuild}ms`);

  let insertOk = true;
  const tIns = Date.now();
  if (!hasStrokeLinks) {
    // Simple path: masks + content in one batch; the end-of-expand reload (in
    // expandSections) is the only refresh.
    const batch = [...maskElements, ...otherElements];
    if (batch.length > 0) {
      const ins: any = await PluginFileAPI.insertElements(filePath, page, batch);
      insertOk = !!ins?.success;
      if (!insertOk) console.error(`${LOG} insertElements failed res=${JSON.stringify(ins)}`);
      for (const el of batch) { try { el.recycle?.(); } catch { /* ignore */ } }
    }
  } else {
    // Stroke-link path: rebuildStrokeLinks owns the entire insert sequence so it
    // can recover the members' fresh nums with one reload per link. It inserts
    // masks + members, then content + the rebuilt links; the end-of-expand
    // reload surfaces the links.
    insertOk = await rebuildStrokeLinks({
      filePath, page, collapsedElements: section.collapsedElements,
      sectionId: section.id, emrDelta, pageMaxX, pageMaxY, dx, dy,
      maskElements, otherElements,
    });
  }
  dlog(`${LOG} PERF expand insertElements=${Date.now() - tIns}ms`);

  // Deliberately NO saveCurrentNote here. insertElements wrote the content to
  // the REAL note file; saveCurrentNote would push the (often still-stale)
  // CACHED/displayed copy back over the real file and clobber the inserts. The
  // end-of-batch reloadFile (in expandSections) reloads the displayed copy FROM
  // the real file, which deterministically surfaces the inserts. See SDK_DOC.md.
  // While expanded, the collapsed content is live on the page as CE_PART
  // elements, and recollapse rebuilds the payload by re-serializing those — so
  // the icon's userData does NOT need to carry `collapsedElements` while
  // expanded. Drop them so we don't rewrite the whole payload just to flip
  // `isExpanded`. Only drop when the insert SUCCEEDED, preserving the invariant
  // of exactly one durable copy of the content: in userData while collapsed, on
  // the page (CE_PART) while expanded. If the insert failed, keep the full
  // payload in userData as the fallback so nothing is lost.
  const expandedState: CollapseSection = {
    ...section,
    isExpanded: true,
    iconRect: iconRectNow,
    collapsedElements: insertOk ? [] : section.collapsedElements,
    preservedNums,
  };

  const tWrite = Date.now();
  const ok = await writeSection(filePath, page, iconElement, expandedState);
  if (!ok) console.error(`${LOG} failed to update section userData after expand`);
  dlog(`${LOG} PERF expand writeSection=${Date.now() - tWrite}ms`);
}

// Expand one or more sections. The user can lasso several collapsed section
// icons (optionally together with loose strokes) and expand them all in one
// press. Flush once, dismiss the lasso once, expand each section, then reloadFile
// ONCE — so N sections cost a SINGLE on-screen refresh (a section containing a
// stroke link still adds its own internal reloads; see rebuildStrokeLinks). Any
// loose strokes in the selection are left untouched (expand only inserts; the
// lasso dismissal commits them back to the page unchanged).
export async function expandSections(
  targets: { section: CollapseSection; icon: any }[],
  filePath: string,
  page: number,
): Promise<void> {
  if (targets.length === 0) return;

  // Flush in-flight strokes (e.g. the icon moved while collapsed) once, so the
  // per-section icon-rect reads below see the current state.
  await PluginNoteAPI.saveCurrentNote();

  // Dismiss the user's lasso once, before any file-level insert, so we never
  // mutate with a lifted selection. (Committing the lasso also returns any loose
  // selected strokes to the page unchanged.)
  await PluginCommAPI.setLassoBoxState(2);

  for (const t of targets) {
    await expandOne(t.section, t.icon, filePath, page, true); // real expand: capture preservedNums
  }

  // Surface every section's inserts with a single refresh.
  const tReload = Date.now();
  await PluginCommAPI.reloadFile();
  dlog(`${LOG} PERF expand reload=${Date.now() - tReload}ms`);
}
