import { PluginCommAPI, PluginFileAPI, PluginNoteAPI, NativeUIUtils, Point, PointUtils, Rect } from 'sn-plugin-lib';
import { CE_NAME_PREFIX, CE_UNDERLINE_PREFIX, dlog, ELEMENT_TYPES, LOG, UNDERLINE_GAP } from '../constants';
import { buildElement, contentBoundingBox, getPageSize, serializeElement } from '../utils/elementSerializer';
import { isUnstableNoteError, readUserData } from '../utils/userDataManager';
import { ensureAllPermissions } from '../utils/permissions';
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

export function findUnderlineElements(all: any[], sectionId: string): any[] {
  return all.filter((el) => {
    const ud = readUserData(el);
    return ud?.kind === 'underline' && ud.id === sectionId;
  });
}

// A single straight-line GEO element spanning nameBBox's width, offset down
// by UNDERLINE_GAP. Points are raw Android pixel coordinates — no EMR
// conversion needed for a freshly-created (not stroke-derived) GEO element,
// same convention as maskHelpers.ts's createBorderRectangle.
export async function createUnderlineElement(nameBBox: Rect, page: number, sectionId: string): Promise<any | null> {
  const res: any = await PluginCommAPI.createElement(ELEMENT_TYPES.GEO);
  if (!res?.success || !res.result) {
    console.error(`${LOG} createUnderlineElement failed res=${JSON.stringify(res)}`);
    return null;
  }
  const el: any = res.result;
  const y = nameBBox.bottom + UNDERLINE_GAP;
  el.geometry = {
    type: 'straightLine',
    points: [
      { x: nameBBox.left, y },
      { x: nameBBox.right, y },
    ],
    penColor: 0x00,
    penType: 10, // solid; penType 0 is rejected by the API
    penWidth: 400, // matches the frame outline's ~4px line
  };
  el.pageNum = page;
  el.userData = CE_UNDERLINE_PREFIX + sectionId;
  return el;
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
// page.
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
// STROKE elements from the lasso) plus any of this section's own existing
// name strokes re-selected in the same lasso (`nameTaggedInLasso` — lets
// writing new ink in among an existing name, e.g. "Name" -> "Name 2", keep
// the old ink instead of dropping it). Returns true if
// the caller should fall through to a normal Expand instead (user declined,
// or nothing usable was selected) — the busy plugin view must be closed by
// the caller before this runs (showRattaDialog is a blocking native modal,
// same suppression risk as alert() while showPluginView is active) and
// reopened after it returns.
export async function handleNameAction(
  target: { section: CollapseSection; icon: any },
  nameCandidates: any[],
  nameTaggedInLasso: any[],
  filePath: string,
  page: number,
): Promise<boolean> {
  const strokeCandidates = nameCandidates.filter((el) => el.type === ELEMENT_TYPES.STROKE);
  if (strokeCandidates.length === 0) return true;

  // Old name strokes belonging to *this* section, re-selected in the same
  // lasso — keep their content instead of silently dropping it. Strokes
  // tagged for a different section (swept in by a sloppy lasso) are ignored.
  const keptOldNameEls = nameTaggedInLasso.filter((el) => {
    const ud = readUserData(el);
    return ud?.kind === 'name' && ud.id === target.section.id;
  });
  const allNameCandidates = [...strokeCandidates, ...keptOldNameEls];

  // Asked upfront, before the confirm dialog: READ is needed just to know
  // whether this is a Set or a Replace (existingNameEls) before the dialog
  // can even be worded, and asking for everything now (rather than READ
  // here + WRITE/DELETE after confirm) means one prompt instead of two.
  // Denial here means false, not true: this is a real rename attempt (the
  // user already lassoed a name + a collapsed icon), not "nothing to
  // rename," so it must not silently fall back to Expand.
  const permitted = await ensureAllPermissions(
    'Collapse/Expand needs permission to read and change the page to set this name.',
  );
  if (!permitted) return false;

  // Flush pending interactive edits (a draw or an erase lives only in the
  // cached copy until saved) before reading state or mutating — otherwise
  // the later reloadFile() reloads cache from a real file that never
  // received e.g. an erase, reverting it. Same pattern as collapseAction.ts
  // / expandSections / recollapseSections.
  await PluginNoteAPI.saveCurrentNote();

  const allRes: any = await PluginFileAPI.getElements(page, filePath);
  const all: any[] = allRes?.success && Array.isArray(allRes.result) ? allRes.result : [];
  const existingNameEls = findNameElements(all, target.section.id);

  const message = existingNameEls.length > 0
    ? "Replace this section's name with the selected handwriting?"
    : "Set this section's name to the selected handwriting?";
  const confirmRes = await NativeUIUtils.showRattaDialog(message, 'Cancel', 'Confirm', true);
  if (!confirmRes) return true;

  const serialized: CollapsedElement[] = [];
  for (const el of allNameCandidates) {
    const data = await serializeElement(el);
    if (data) serialized.push({ numInPage: el.numInPage, data });
  }
  if (serialized.length === 0) {
    alert('Nothing nameable in selection.');
    return false;
  }

  const pageSize = await getPageSize(filePath, page);

  // No translation — the name stays exactly where the user wrote it.
  // pageMaxX/pageMaxY are still needed to rescale a stroke's own EMR space
  // to the page's (see rebuildNameElements's doc), independent of position.
  const pageMaxX = PointUtils.getRealMaxX(pageSize);
  const pageMaxY = PointUtils.getRealMaxY(pageSize);

  const newNameEls = await rebuildNameElements(serialized, target.section.id, page, 0, 0, { x: 0, y: 0 }, pageMaxX, pageMaxY);
  if (newNameEls.length === 0) {
    alert('Failed to set the section name — please try again.');
    return false;
  }

  // Underline spans the new name's bbox — inserted in the same batch as the
  // name itself.
  const nameBBox = contentBoundingBox(serialized, pageSize);
  const underlineEl = nameBBox ? await createUnderlineElement(nameBBox, page, target.section.id) : null;
  const insertBatch = underlineEl ? [...newNameEls, underlineEl] : newNameEls;

  // CRASH-SAFETY: insert the new name before deleting the old candidate strokes
  // and any previous name/underline — until the insert lands, both old copies
  // are still present on the page (recoverable), never neither.
  const insertRes: any = await PluginFileAPI.insertElements(filePath, page, insertBatch);
  if (!insertRes?.success) {
    console.error(`${LOG} name insertElements failed res=${JSON.stringify(insertRes)}`);
    if (!isUnstableNoteError(insertRes)) alert("Couldn't set the section name — please try again.");
    for (const el of insertBatch) { try { el.recycle?.(); } catch { /* ignore */ } }
    return false;
  }

  const existingUnderlineEls = findUnderlineElements(all, target.section.id);
  const numsToDelete = [
    ...strokeCandidates.map((el) => el.numInPage),
    ...existingNameEls.map((el) => el.numInPage),
    ...existingUnderlineEls.map((el) => el.numInPage),
  ].filter((n): n is number => typeof n === 'number');
  if (numsToDelete.length > 0) {
    const delRes: any = await PluginFileAPI.deleteElements(filePath, page, numsToDelete);
    if (!delRes?.success) {
      console.error(`${LOG} name deleteElements failed res=${JSON.stringify(delRes)}`);
      if (!isUnstableNoteError(delRes)) alert('Named, but the old strokes could not be removed — please retry.');
    }
  }

  const lassoRes: any = await PluginCommAPI.setLassoBoxState(2);
  if (!lassoRes?.success) {
    // Error 904 here is expected — see collapseAction.ts's identical comment.
    if (lassoRes?.error?.code === 904) {
      dlog(`${LOG} name setLassoBoxState res=${JSON.stringify(lassoRes)} (expected)`);
    } else {
      console.error(`${LOG} name setLassoBoxState res=${JSON.stringify(lassoRes)}`);
    }
  }
  const reloadRes: any = await PluginCommAPI.reloadFile();
  if (!reloadRes?.success) console.error(`${LOG} name reloadFile res=${JSON.stringify(reloadRes)}`);
  return false;
}
