import { PluginCommAPI, PluginFileAPI, PluginNoteAPI, PointUtils, Rect } from 'sn-plugin-lib';
import { CE_PART_PREFIX, LOG } from '../constants';
import { buildElement } from '../utils/elementSerializer';
import { getCurrentIconRect, writeSection } from '../utils/userDataManager';
import { createMaskElements } from '../utils/maskHelpers';
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
  console.log(`${LOG} SIZE expand icon userData=${iconElement?.userData?.length ?? 0} bytes, collapsed=${section.collapsedElements?.length ?? 0} element(s)`);

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

  console.log(`${LOG} PERF expand entry(save+iconrect+dismiss-lasso)=${Date.now() - tEntry}ms`);

  const fileElements: any[] = [];

  const tBuild = Date.now();
  // Mask rings first so they sit below the collapsed content in this batch.
  const maskElements = await createMaskElements(contentRect, page, section.id);
  for (const m of maskElements) fileElements.push(m);

  for (const ce of section.collapsedElements) {
    const el = await buildElement(ce.data, page, CE_PART_PREFIX + section.id, emrDelta, pageMaxX, pageMaxY, dx, dy);
    if (el) fileElements.push(el);
    else console.error(`${LOG} buildElement returned null for kind=${ce.data.kind}`);
  }
  console.log(`${LOG} PERF expand build=${Date.now() - tBuild}ms for ${fileElements.length} element(s)`);

  if (fileElements.length > 0) {
    const tIns = Date.now();
    const ins: any = await PluginFileAPI.insertElements(filePath, page, fileElements);
    console.log(`${LOG} PERF expand insertElements=${Date.now() - tIns}ms`);
    if (!ins?.success) {
      console.error(`${LOG} insertElements failed res=${JSON.stringify(ins)}`);
    }
    for (const el of fileElements) {
      try { el.recycle?.(); } catch { /* ignore */ }
    }
  }

  // Deliberately NO saveCurrentNote here. insertElements wrote the content to
  // the REAL note file; saveCurrentNote would push the (often still-stale)
  // CACHED/displayed copy back over the real file and clobber the inserts. The
  // SDK's async real→cached sync is unreliable — it sometimes never fires, so
  // getElements can stay stale for >10s. reloadFile below instead reloads the
  // displayed copy FROM the real file, which deterministically surfaces the
  // inserts (confirmed: reloadFile shows the full count even when the async
  // sync never landed). See SDK_DOC.md ("Plugin writes hit the REAL file …").
  section.isExpanded = true;
  section.iconRect = iconRectNow;

  const tWrite = Date.now();
  const ok = await writeSection(filePath, page, iconElement, section);
  if (!ok) console.error(`${LOG} failed to update section userData after expand`);
  console.log(`${LOG} PERF expand writeSection=${Date.now() - tWrite}ms`);

  const tReload = Date.now();
  await PluginCommAPI.reloadFile();
  console.log(`${LOG} PERF expand reload=${Date.now() - tReload}ms`);
}
