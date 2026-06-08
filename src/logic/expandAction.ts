import { PluginCommAPI, PluginFileAPI, PluginNoteAPI, PointUtils, Rect } from 'sn-plugin-lib';
import { CE_PART_PREFIX, LOG } from '../constants';
import { dumpElements } from '../utils/diagnostics';
import { buildElement } from '../utils/elementSerializer';
import { getCurrentIconRect, readUserData, writeSection } from '../utils/userDataManager';
import { createMaskElements } from '../utils/maskHelpers';
import { CollapseSection } from '../model/types';

export async function expandAction(
  section: CollapseSection,
  iconElement: any,
  filePath: string,
  page: number,
) {
  // Flush any in-flight strokes the user drew while collapsed so getElements
  // below sees them, then dump page state at expand entry. This lets us
  // diagnose whether pre-expand user strokes (drawn around the icon) survive
  // the expand → recollapse cycle.
  await PluginNoteAPI.saveCurrentNote();
  await dumpElements('DIAG expand entry', filePath, page);

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

  // Identify pre-existing untagged elements sitting under contentRect so
  // recollapse can skip them when absorbing untagged strokes drawn during
  // expansion. We don't tag them on the element itself (modifyElements is
  // unreliable for in-place metadata edits in this SDK build); we record
  // their numInPage values on the section state instead.
  await PluginCommAPI.lassoElements(contentRect);
  const presLassoRes: any = await PluginCommAPI.getLassoElements();
  const presLassoed: any[] = presLassoRes?.success ? (presLassoRes.result ?? []) : [];
  const preservedNums: number[] = [];
  for (const el of presLassoed) {
    if (typeof el?.numInPage !== 'number') continue;
    if (readUserData(el) !== null) continue;
    preservedNums.push(el.numInPage);
  }
  for (const el of presLassoed) { try { el.recycle?.(); } catch { /* ignore */ } }
  section.preservedNums = preservedNums;
  console.log(`${LOG} expand preservedNums=[${preservedNums.join(',')}] of lassoed=${presLassoed.length}`);

  // Close the programmatic read-lasso now that we've read it, BEFORE the
  // file-level inserts below. Leaving it open (especially when it lifted
  // pre-existing strokes sitting under the section) leaves the note app's
  // trail bookkeeping half-committed and is what breaks the "strokes below"
  // case. We only opened this lasso to read; nothing below needs it.
  await PluginCommAPI.setLassoBoxState(2);

  const fileElements: any[] = [];

  // Mask rings first so they sit below the collapsed content in this batch.
  const maskElements = await createMaskElements(contentRect, page, section.id);
  for (const m of maskElements) fileElements.push(m);

  for (const ce of section.collapsedElements) {
    const el = await buildElement(ce.data, page, CE_PART_PREFIX + section.id, emrDelta, pageMaxX, pageMaxY, dx, dy);
    if (el) fileElements.push(el);
    else console.error(`${LOG} buildElement returned null for kind=${ce.data.kind}`);
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
  await dumpElements('DIAG expand after insert', filePath, page);

  await PluginNoteAPI.saveCurrentNote();
  await dumpElements('DIAG expand after save', filePath, page);

  section.isExpanded = true;
  section.iconRect = iconRectNow;

  const ok = await writeSection(filePath, page, iconElement, section);
  if (!ok) console.error(`${LOG} failed to update section userData after expand`);

  await PluginCommAPI.reloadFile();
}
