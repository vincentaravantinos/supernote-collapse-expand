import { NativeUIUtils, PluginCommAPI, PluginFileAPI, PluginNoteAPI, Point, PointUtils, Rect } from 'sn-plugin-lib';
import { CE_NAME_PREFIX, ELEMENT_TYPES, LOG } from '../constants';
import { buildElement, contentBoundingBox, serializeElement } from '../utils/elementSerializer';
import { readUserData, writeSection } from '../utils/userDataManager';
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

// Sub-pixel tolerance for "did the name move on its own" — matches the
// existing icon-moved check in iconMoveRedraw.ts.
const NAME_MOVE_TOLERANCE = 1;

// Decide whether the name should auto-follow the icon's own movement delta
// (iconDx, iconDy) or be left exactly where it is. The name only follows if
// it hasn't moved on its own since it was last synced — if the user moved it
// (alone, or together with the icon, collapsed or expanded), its current
// position is trusted untouched. See BUGS/B-003.md.
export function nameFollowDelta(
  currentNameBBox: Rect,
  syncedNameRect: Rect | undefined,
  iconDx: number,
  iconDy: number,
): { dx: number; dy: number } {
  if (!syncedNameRect) return { dx: 0, dy: 0 };
  const nameMoved =
    Math.abs(currentNameBBox.left - syncedNameRect.left) > NAME_MOVE_TOLERANCE ||
    Math.abs(currentNameBBox.top - syncedNameRect.top) > NAME_MOVE_TOLERANCE;
  return nameMoved ? { dx: 0, dy: 0 } : { dx: iconDx, dy: iconDy };
}

// Confirm + set/replace a section's name from `nameCandidates` (untagged
// STROKE elements from the lasso) plus any of this section's own existing
// name strokes re-selected in the same lasso (`nameTaggedInLasso` — lets
// writing new ink in among an existing name, e.g. "Name" -> "Name 2", keep
// the old ink instead of dropping it; see BUGS/B-005.md). Returns true if
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

  // Flush pending interactive edits (a draw or an erase lives only in the
  // cached copy until saved) before reading state or mutating — otherwise
  // the later reloadFile() reloads cache from a real file that never
  // received e.g. an erase, reverting it. Same pattern as collapseAction.ts
  // / expandSections / recollapseSections. See BUGS/B-002.md.
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

  const sizeRes: any = await PluginFileAPI.getPageSize(filePath, page);
  const pageSize = sizeRes?.success && sizeRes.result
    ? { width: sizeRes.result.width, height: sizeRes.result.height }
    : { width: 1404, height: 1872 };

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

  // Persist the name's position as the baseline for future icon-move
  // reconciliation (nameFollowDelta) — there's no prior baseline before a
  // name exists (or a rename resets it).
  const bbox = contentBoundingBox(serialized, pageSize);
  if (bbox) {
    const freshIcon = all.find((el) => {
      const ud = readUserData(el);
      return ud?.kind === 'section' && ud.section?.id === target.section.id;
    }) ?? target.icon;
    const ok = await writeSection(filePath, page, target.icon, { ...target.section, nameSyncedRect: bbox }, freshIcon);
    if (!ok) console.error(`${LOG} name: failed to sync nameSyncedRect`);
  }

  await PluginCommAPI.setLassoBoxState(2);
  await PluginCommAPI.reloadFile();
  return false;
}
