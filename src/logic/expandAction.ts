import { PluginCommAPI, PluginFileAPI, PluginNoteAPI, PointUtils, Rect } from 'sn-plugin-lib';
import { CE_PART_PREFIX, dlog, LOG } from '../constants';
import { buildElement } from '../utils/elementSerializer';
import { getCurrentIconRect, writeSection } from '../utils/userDataManager';
import { createMaskElements } from '../utils/maskHelpers';
import { rebuildStrokeLinks, strokeLinkMemberIndices } from './strokeLinkExpand';
import { CollapseSection } from '../model/types';

export async function expandAction(
  section: CollapseSection,
  iconElement: any,
  filePath: string,
  page: number,
) {
  // SIZE PROBE: the round-tripped userData length read back from the icon. If
  // this is much smaller than what collapse wrote, the userData was truncated
  // (real ceiling); if it matches, big payloads survive the write/read.
  dlog(`${LOG} SIZE expand icon userData=${iconElement?.userData?.length ?? 0} bytes, collapsed=${section.collapsedElements?.length ?? 0} element(s)`);

  const tEntry = Date.now();
  // Flush any in-flight strokes the user drew while collapsed so getElements
  // below sees them.
  await PluginNoteAPI.saveCurrentNote();

  // Read the icon's CURRENT rect from the persisted element list, not from
  // the lassoed element (which can report a stale rect after a move).
  const iconRectNow = await getCurrentIconRect(filePath, page, section, iconElement);
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

  // Dismiss the user's lasso (they lassoed the icon to trigger expand) BEFORE
  // the file-level inserts below, so we never mutate with a lifted selection.
  // We used to also lasso contentRect here to record `preservedNums` for
  // recollapse's "absorb strokes drawn during expansion" feature — but that
  // feature is disabled (see ABSORB_STROKES_VIA_LASSO in recollapseAction), so
  // that whole read-lasso (lassoElements + getLassoElements + iterate) was dead
  // work. Removing it drops ~1.4s off expand. If absorb is ever re-enabled,
  // restore the preservedNums capture here.
  await PluginCommAPI.setLassoBoxState(2);

  dlog(`${LOG} PERF expand entry(save+iconrect+dismiss-lasso)=${Date.now() - tEntry}ms`);

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
    // Simple path: masks + content in one batch; the end-of-expand reload below
    // is the only refresh.
    const batch = [...maskElements, ...otherElements];
    if (batch.length > 0) {
      const ins: any = await PluginFileAPI.insertElements(filePath, page, batch);
      insertOk = !!ins?.success;
      if (!insertOk) console.error(`${LOG} insertElements failed res=${JSON.stringify(ins)}`);
      for (const el of batch) { try { el.recycle?.(); } catch { /* ignore */ } }
    }
  } else {
    // Stroke-link path: rebuildStrokeLinks owns the entire insert sequence so it
    // can recover the members' fresh nums with one reload per link (no extra
    // baseline reload). It inserts masks + members, then content + the rebuilt
    // links; the end-of-expand reload surfaces the links.
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
  // SDK's async real→cached sync is unreliable — it sometimes never fires, so
  // getElements can stay stale for >10s. reloadFile below instead reloads the
  // displayed copy FROM the real file, which deterministically surfaces the
  // inserts (confirmed: reloadFile shows the full count even when the async
  // sync never landed). See SDK_DOC.md ("Plugin writes hit the REAL file …").
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
  };

  const tWrite = Date.now();
  const ok = await writeSection(filePath, page, iconElement, expandedState);
  if (!ok) console.error(`${LOG} failed to update section userData after expand`);
  dlog(`${LOG} PERF expand writeSection=${Date.now() - tWrite}ms`);

  const tReload = Date.now();
  await PluginCommAPI.reloadFile();
  dlog(`${LOG} PERF expand reload=${Date.now() - tReload}ms`);
}
