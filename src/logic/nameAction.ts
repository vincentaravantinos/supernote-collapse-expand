import { NativeUIUtils, PluginCommAPI, PluginFileAPI, Point, PointUtils } from 'sn-plugin-lib';
import { CE_NAME_PREFIX, ELEMENT_TYPES, LOG, NAME_GAP } from '../constants';
import { buildElement, contentBoundingBox, serializeElement } from '../utils/elementSerializer';
import { iconRectFromElements, readUserData } from '../utils/userDataManager';
import { CollapsedElement, CollapseSection } from '../model/types';

// Elements tagged as a given section's name (there is no per-element id — every
// name stroke shares the same CE_NAME:<sectionId> tag, same convention as
// CE_PART/CE_MASK/CE_FRAME).
export function findNameElements(all: any[], sectionId: string): any[] {
  return all.filter((el) => {
    const ud = readUserData(el);
    return ud?.kind === 'name' && ud.id === sectionId;
  });
}

// Rebuild `serialized` (already-serialized name strokes) translated by
// (dxPx, dyPx) in android space / `emrDelta` in EMR space, tagged
// CE_NAME:<sectionId>. Shared by the Name/Rename action and by the icon-move
// reconciliation paths (expandAction, iconMoveRedraw) that keep a name
// attached to its icon.
//
// `emrDelta` MUST be computed by the caller as the difference of two
// independently-converted EMR points (`androidPoint2Emr(to) -
// androidPoint2Emr(from)`), never by converting the (dxPx, dyPx) delta
// directly — androidPoint2Emr is not a linear map through the origin (it
// flips/offsets between android's and EMR's coordinate conventions), so
// converting a bare delta injects a spurious offset that lands strokes off
// page. See BUGS/B-001.md.
export async function rebuildNameElements(
  serialized: CollapsedElement[],
  sectionId: string,
  page: number,
  dxPx: number,
  dyPx: number,
  emrDelta: Point,
  pageMaxX: number,
  pageMaxY: number,
): Promise<any[]> {
  const built: any[] = [];
  for (const ce of serialized) {
    if (ce.data.kind !== 'stroke') continue; // names are handwritten ink only
    const el = await buildElement(ce.data, page, CE_NAME_PREFIX + sectionId, emrDelta, pageMaxX, pageMaxY, dxPx, dyPx);
    if (el) built.push(el);
  }
  return built;
}

// Confirm + set/replace a section's name from `nameCandidates` (untagged
// STROKE elements from the lasso). Returns true if the caller should fall
// through to a normal Expand instead (user declined, or nothing usable was
// selected) — the busy plugin view must be closed by the caller before this
// runs (showRattaDialog is a blocking native modal, same suppression risk as
// alert() while showPluginView is active) and reopened after it returns.
export async function handleNameAction(
  target: { section: CollapseSection; icon: any },
  nameCandidates: any[],
  filePath: string,
  page: number,
): Promise<boolean> {
  const strokeCandidates = nameCandidates.filter((el) => el.type === ELEMENT_TYPES.STROKE);
  if (strokeCandidates.length === 0) return true;

  const allRes: any = await PluginFileAPI.getElements(page, filePath);
  const all: any[] = allRes?.success && Array.isArray(allRes.result) ? allRes.result : [];
  const iconRectNow = iconRectFromElements(all, target.section, target.icon);
  const existingNameEls = findNameElements(all, target.section.id);

  const message = existingNameEls.length > 0
    ? "Replace this section's name with the selected handwriting?"
    : "Set this section's name to the selected handwriting?";
  const confirmRes = await NativeUIUtils.showRattaDialog(message, 'Cancel', 'Confirm', true);
  if (!confirmRes) return true;

  const serialized: CollapsedElement[] = [];
  for (const el of strokeCandidates) {
    const data = await serializeElement(el);
    if (data) serialized.push({ numInPage: el.numInPage, data });
  }
  if (serialized.length === 0) {
    alert('Nothing nameable in selection.');
    return false;
  }

  const sizeRes: any = await PluginFileAPI.getPageSize(filePath, page);
  const pageSize = sizeRes?.success && sizeRes.result
    ? { width: sizeRes.result.width, height: sizeRes.result.height }
    : { width: 1404, height: 1872 };

  const bbox = contentBoundingBox(serialized, pageSize);
  if (!bbox) {
    alert('Nothing nameable in selection.');
    return false;
  }
  const width = bbox.right - bbox.left;
  const height = bbox.bottom - bbox.top;
  // Anchor up-right of the icon; clamped into the page like the icon's own
  // placement — best-effort, not guaranteed collision-free for a large name.
  const anchorLeft = Math.max(0, Math.min(iconRectNow.right + NAME_GAP, pageSize.width - width));
  const anchorTop = Math.max(0, Math.min(iconRectNow.top, pageSize.height - height));
  const dxPx = anchorLeft - bbox.left;
  const dyPx = anchorTop - bbox.top;

  // Safe two-point EMR delta (see rebuildNameElements doc) — convert the
  // "from" and "to" android points independently, then subtract.
  const emrFrom = PointUtils.androidPoint2Emr({ x: bbox.left, y: bbox.top }, pageSize);
  const emrTo = PointUtils.androidPoint2Emr({ x: anchorLeft, y: anchorTop }, pageSize);
  const emrDelta = { x: emrTo.x - emrFrom.x, y: emrTo.y - emrFrom.y };
  const pageMaxX = PointUtils.getRealMaxX(pageSize);
  const pageMaxY = PointUtils.getRealMaxY(pageSize);

  const newNameEls = await rebuildNameElements(serialized, target.section.id, page, dxPx, dyPx, emrDelta, pageMaxX, pageMaxY);
  if (newNameEls.length === 0) {
    alert('Failed to set the section name — please try again.');
    return false;
  }

  // CRASH-SAFETY: insert the new name before deleting the old candidate strokes
  // and any previous name — until the insert lands, both old copies are still
  // present on the page (recoverable), never neither.
  const insertRes: any = await PluginFileAPI.insertElements(filePath, page, newNameEls);
  if (!insertRes?.success) {
    console.error(`${LOG} name insertElements failed res=${JSON.stringify(insertRes)}`);
    alert("Couldn't set the section name — please try again.");
    for (const el of newNameEls) { try { el.recycle?.(); } catch { /* ignore */ } }
    return false;
  }

  const numsToDelete = [
    ...strokeCandidates.map((el) => el.numInPage),
    ...existingNameEls.map((el) => el.numInPage),
  ].filter((n): n is number => typeof n === 'number');
  if (numsToDelete.length > 0) {
    const delRes: any = await PluginFileAPI.deleteElements(filePath, page, numsToDelete);
    if (!delRes?.success) {
      console.error(`${LOG} name deleteElements failed res=${JSON.stringify(delRes)}`);
      alert('Named, but the old strokes could not be removed — please retry.');
    }
  }

  await PluginCommAPI.setLassoBoxState(2);
  await PluginCommAPI.reloadFile();
  return false;
}
