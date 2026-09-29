import { PluginCommAPI, PluginFileAPI, PluginNoteAPI, Point, PointUtils, Rect } from 'sn-plugin-lib';
import { CE_NAME_PREFIX, CE_UNDERLINE_PREFIX, ELEMENT_TYPES, LOG, UNDERLINE_GAP } from '../constants';
import { buildElement, contentBoundingBox, getPageSize, serializeElement } from '../utils/elementSerializer';
import { deleteElementsVerified, isUnstableNoteError, readUserData } from '../utils/userDataManager';
import { reloadFileWithTimeout } from '../utils/reloadFile';
import { ensureAllPermissions } from '../utils/permissions';
import { dismissLassoAfterDelete } from '../utils/lassoHelpers';
import { CollapsedElement, CollapseSection } from '../model/types';
import type { Operation } from './operation';

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

// What the caller does after naming: nothing more ('done' — named, or failed
// with its own alert), dismiss the lasso ('cancel' — the user declined the
// rename confirmation), or show the "no action applies" message ('nothing' —
// the lasso only re-selected an intact name, REQ-635).
export type NameOutcome = 'done' | 'cancel' | 'nothing';

// Drift allowed between a name and its underline before the underline counts
// as no longer matching: dragging an expanded section's icon rebuilds the two
// separately, so they can round a pixel or two apart.
const UNDERLINE_TOLERANCE_PX = 6;

async function bboxOf(els: any[], pageSize: { width: number; height: number }): Promise<Rect | null> {
  const serialized: CollapsedElement[] = [];
  for (const el of els) {
    const data = await serializeElement(el);
    if (data) serialized.push({ numInPage: el.numInPage, data });
  }
  return contentBoundingBox(serialized, pageSize);
}

// Does the section's underline still span its name (REQ-630/632/635)?
async function underlineMatches(nameEls: any[], underlineEls: any[], pageSize: { width: number; height: number }): Promise<boolean> {
  if (underlineEls.length !== 1) return false;
  const name = await bboxOf(nameEls, pageSize);
  const line = await bboxOf(underlineEls, pageSize);
  if (!name || !line) return false;
  const near = (a: number, b: number) => Math.abs(a - b) <= UNDERLINE_TOLERANCE_PX;
  return near(line.left, name.left) && near(line.right, name.right) && near(line.top, name.bottom + UNDERLINE_GAP);
}

// Set/replace a section's name from `nameCandidates` (untagged STROKE
// elements from the lasso) plus any of this section's own existing name
// strokes re-selected in the same lasso (`nameTaggedInLasso` — lets writing
// new ink in among an existing name, e.g. "Name" -> "Name 2", keep the old
// ink instead of dropping it). Works on a collapsed or an expanded section
// alike. Asks first when setting a first name (REQ-675), or when a rename
// would drop existing name strokes the user didn't lasso (REQ-670).
export async function handleNameAction(
  op: Operation,
  target: { section: CollapseSection; icon: any },
  nameCandidates: any[],
  nameTaggedInLasso: any[],
  filePath: string,
  page: number,
): Promise<NameOutcome> {
  const strokeCandidates = nameCandidates.filter((el) => el.type === ELEMENT_TYPES.STROKE);

  // Old name strokes belonging to *this* section, re-selected in the same
  // lasso — keep their content instead of silently dropping it. Strokes
  // tagged for a different section (swept in by a sloppy lasso) are ignored.
  const keptOldNameEls = nameTaggedInLasso.filter((el) => {
    const ud = readUserData(el);
    return ud?.kind === 'name' && ud.id === target.section.id;
  });
  if (strokeCandidates.length === 0 && keptOldNameEls.length === 0) return 'nothing';
  const allNameCandidates = [...strokeCandidates, ...keptOldNameEls];

  // Asked upfront: READ is needed to compare against the section's existing
  // name before deciding anything, and asking for everything now means one
  // prompt instead of two.
  const permitted = await ensureAllPermissions(
    'Collapse/Expand needs permission to read and change the page to set this name.',
  );
  if (!permitted) return 'done';

  // Flush pending interactive edits (a draw or an erase lives only in the
  // cached copy until saved) before reading state or mutating — otherwise
  // the read below can miss it (e.g. an erase not yet reflected). Same
  // pattern as collapseAction.ts / expandSections / recollapseSections.
  await PluginNoteAPI.saveCurrentNote();

  const allRes: any = await PluginFileAPI.getElements(page, filePath);
  const all: any[] = allRes?.success && Array.isArray(allRes.result) ? allRes.result : [];
  const existingNameEls = findNameElements(all, target.section.id);
  const lassoedOwn = new Set<number>(keptOldNameEls.map((el) => el.numInPage));
  const dropsExisting = existingNameEls.some((el) => !lassoedOwn.has(el.numInPage));

  // Only the intact, still-underlined name re-selected: renaming would change
  // nothing (REQ-635). A drifted or missing underline is what makes a
  // re-selection of the whole name worth redoing (REQ-630/632).
  if (strokeCandidates.length === 0 && !dropsExisting) {
    const pageSizeNow = await getPageSize(filePath, page);
    if (await underlineMatches(existingNameEls, findUnderlineElements(all, target.section.id), pageSizeNow)) return 'nothing';
  }

  if (existingNameEls.length === 0) {
    const choice = await op.ask(
      "Set this handwriting as the section's name? It stays next to the icon, whether the section is collapsed or expanded.",
      [{ id: 'name', label: 'Set as name' }, { id: 'cancel', label: 'Cancel' }],
    ); // REQ-675
    if (choice !== 'name') return 'cancel';
  } else if (dropsExisting) {
    const choice = await op.ask(
      "This replaces the section's current name — any part of it you didn't select will be removed.",
      [{ id: 'rename', label: 'Rename' }, { id: 'cancel', label: 'Cancel' }],
    ); // REQ-670
    if (choice !== 'rename') return 'cancel';
  }

  const serialized: CollapsedElement[] = [];
  for (const el of allNameCandidates) {
    const data = await serializeElement(el);
    if (data) serialized.push({ numInPage: el.numInPage, data });
  }
  if (serialized.length === 0) {
    await op.alert('Nothing nameable in selection.');
    return 'done';
  }

  const pageSize = await getPageSize(filePath, page);

  // No translation — the name stays exactly where the user wrote it.
  // pageMaxX/pageMaxY are still needed to rescale a stroke's own EMR space
  // to the page's (see rebuildNameElements's doc), independent of position.
  const pageMaxX = PointUtils.getRealMaxX(pageSize);
  const pageMaxY = PointUtils.getRealMaxY(pageSize);

  const newNameEls = await rebuildNameElements(serialized, target.section.id, page, 0, 0, { x: 0, y: 0 }, pageMaxX, pageMaxY);
  if (newNameEls.length === 0) {
    await op.alert('Failed to set the section name — please try again.');
    return 'done';
  }

  // Underline spans the new name's bbox — inserted in the same batch as the
  // name itself.
  const nameBBox = contentBoundingBox(serialized, pageSize);
  const underlineEl = nameBBox ? await createUnderlineElement(nameBBox, page, target.section.id) : null;
  const insertBatch = underlineEl ? [...newNameEls, underlineEl] : newNameEls;

  // CRASH-SAFETY: insert the new name before deleting the old candidate strokes
  // and any previous name/underline — until the insert lands, both old copies
  // are still present on the page (recoverable), never neither. insertElements
  // can report success without landing, so count this section's name strokes
  // on a re-read (old ones are still there, the new ones must be on top).
  const insertRes: any = await PluginFileAPI.insertElements(filePath, page, insertBatch);
  let nameLanded = false;
  if (insertRes?.success) {
    await reloadFileWithTimeout(); // without this, the read below can miss a just-landed insert
    const checkRes: any = await PluginFileAPI.getElements(page, filePath);
    const check: any[] = checkRes?.success && Array.isArray(checkRes.result) ? checkRes.result : [];
    nameLanded = findNameElements(check, target.section.id).length >= existingNameEls.length + newNameEls.length;
  }
  for (const el of insertBatch) { try { el.recycle?.(); } catch { /* ignore */ } }
  if (!nameLanded) {
    console.error(`${LOG} name insert didn't land res=${JSON.stringify(insertRes)} — nothing deleted`);
    if (!isUnstableNoteError(insertRes)) await op.alert("Couldn't set the section name — please try again.");
    return 'done';
  }

  const existingUnderlineEls = findUnderlineElements(all, target.section.id);
  const numsToDelete = [
    ...strokeCandidates.map((el) => el.numInPage),
    ...existingNameEls.map((el) => el.numInPage),
    ...existingUnderlineEls.map((el) => el.numInPage),
  ].filter((n): n is number => typeof n === 'number');
  if (numsToDelete.length > 0) {
    const { ok: deleteOk, remaining, unstableNote } = await deleteElementsVerified(filePath, page, numsToDelete);
    if (!deleteOk) {
      console.error(`${LOG} name: ${remaining.length} old element(s) never removed: ${JSON.stringify(remaining)}`);
      if (!unstableNote) await op.alert('Named, but the old strokes could not be removed — please retry.');
    }
  }

  await dismissLassoAfterDelete('name');
  return 'done';
}
