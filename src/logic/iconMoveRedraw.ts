import { PluginCommAPI, PluginFileAPI, PluginNoteAPI, Rect } from 'sn-plugin-lib';
import { LOG, SCHEMA_VERSION, ZONE_MARGIN, dlog } from '../constants';
import { stretchZoneToIcon } from '../utils/geometryHelpers';
import { contentBoundingBox, resolveLinkMemberIndices, serializeElement } from '../utils/elementSerializer';
import { readUserData } from '../utils/userDataManager';
import { CollapseSection, CollapsedElement } from '../model/types';
import { expandedCount, expandedEntries, getExpandedEntry, noteSectionExpanded } from './expandedRegistry';
import { expandOne } from './expandAction';
import { acquireBusy, releaseBusy } from './busy';

function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

// Grabbing a SELECTED element to drag it can land anywhere in its selection box,
// which is padded out beyond the 50px icon — so the DOWN gate tests a padded
// rect, not the tight icon rect. False positives are cheap (one getElements on
// UP that finds no move). Tune if grabs still miss.
const GATE_PAD = 60;

function padded(r: Rect, pad: number): Rect {
  return { left: r.left - pad, top: r.top - pad, right: r.right + pad, bottom: r.bottom + pad };
}

// Section whose icon the current gesture grabbed (set on DOWN, consumed on UP).
let dragCandidateId: string | null = null;

// Motion ACTION_DOWN: pure in-memory gate — did this touch start on (near) one of
// our expanded sections' icons? No SDK call. If not, the UP handler no-ops.
export function onMotionDown(x: number, y: number): void {
  dragCandidateId = null;
  if (expandedCount() === 0) return;
  for (const [id, e] of expandedEntries()) {
    if (rectContains(padded(e.iconRect, GATE_PAD), x, y)) {
      dragCandidateId = id;
      return;
    }
  }
}

// Motion ACTION_UP: if the gesture grabbed an expanded section's icon, redraw
// that section if the icon moved. Only here do we touch the SDK.
export async function onMotionUp(): Promise<void> {
  const id = dragCandidateId;
  dragCandidateId = null;
  if (!id) return;
  if (!getExpandedEntry(id)) return;
  if (!acquireBusy()) return; // a button action or another redraw is in flight
  try {
    await redrawSectionBox(id);
  } catch (e) {
    console.error(`${LOG} live redraw failed: ${e}`);
  } finally {
    releaseBusy();
  }
}

// EXPERIMENT (branch experiment/live-fill-redraw): full redraw — re-fill the
// white mask AND re-place the strokes at the stretched zone, not just the
// outline. Costs a re-serialize of the on-page strokes per drag (accepted: rare
// op). Reuses expandOne so mask/content z-order and stroke links are handled the
// same way as a normal expand; one reloadFile (no collapsed flash).
async function redrawSectionBox(id: string): Promise<void> {
  const entry = getExpandedEntry(id);
  if (!entry) return;

  const fpRes: any = await PluginCommAPI.getCurrentFilePath();
  const pgRes: any = await PluginCommAPI.getCurrentPageNum();
  if (!fpRes?.success || typeof fpRes.result !== 'string') return;
  if (!pgRes?.success || typeof pgRes.result !== 'number') return;
  const filePath = fpRes.result as string;
  const page = pgRes.result as number;

  // Flush the move and dismiss its selection before reading/mutating (mirrors
  // expand: saveCurrentNote → setLassoBoxState(2) → getElements), so the icon's
  // new rect is visible and we never mutate with a lifted selection.
  await PluginNoteAPI.saveCurrentNote();
  await PluginCommAPI.setLassoBoxState(2);

  const allRes: any = await PluginFileAPI.getElements(page, filePath);
  const all: any[] = allRes?.success && Array.isArray(allRes.result) ? allRes.result : [];

  let iconEl: any = null;
  let iconRect: Rect | null = null;
  const partEls: any[] = [];
  const removeNums: number[] = [];
  for (const el of all) {
    const ud = readUserData(el);
    if (!ud) continue;
    if (ud.kind === 'section' && ud.section?.id === id) {
      iconEl = el;
      if (el?.textBox?.textRect) iconRect = el.textBox.textRect;
    } else if (ud.kind === 'part' && ud.id === id) {
      partEls.push(el);
      if (typeof el.numInPage === 'number') removeNums.push(el.numInPage);
    } else if ((ud.kind === 'mask' || ud.kind === 'frame') && ud.id === id && typeof el.numInPage === 'number') {
      removeNums.push(el.numInPage);
    }
  }
  if (!iconEl || !iconRect) { return; } // icon gone — leave it for recollapse

  // Did the icon actually move since we last drew the box? (sub-pixel = no)
  const moved =
    Math.abs(iconRect.left - entry.iconRect.left) > 1 ||
    Math.abs(iconRect.top - entry.iconRect.top) > 1;
  if (!moved) {
    noteSectionExpanded(id, iconRect, entry.contentBBox);
    return;
  }

  // Re-serialize the current on-page content (this is the drain cost), so we can
  // rebuild it above a fresh fill. resolveLinkMemberIndices keeps stroke links.
  let fresh: CollapsedElement[] = [];
  for (const el of partEls) {
    const data = await serializeElement(el);
    if (data) fresh.push({ numInPage: el.numInPage, data });
  }
  fresh = resolveLinkMemberIndices(fresh);
  if (fresh.length === 0) { return; }

  const sizeRes: any = await PluginFileAPI.getPageSize(filePath, page);
  const pageSize = sizeRes?.success && sizeRes.result
    ? { width: sizeRes.result.width, height: sizeRes.result.height }
    : { width: 1404, height: 1872 };
  const bbox = contentBoundingBox(fresh, pageSize);
  if (!bbox) { return; }
  const zone = stretchZoneToIcon(bbox, ZONE_MARGIN, iconRect);

  // Delete the section's content + fill + outline, then re-expand in place. The
  // temp section is anchored to the CURRENT icon (emrDelta=0 ⇒ content rebuilds
  // where it is); relativeRect places the mask at the stretched zone. expandOne
  // re-inserts mask-then-content (correct z-order), handles stroke links,
  // writeSection, and re-registers in the expanded registry. One reloadFile.
  if (removeNums.length > 0) {
    const del: any = await PluginFileAPI.deleteElements(filePath, page, removeNums);
    if (!del?.success) console.error(`${LOG} live redraw deleteElements failed res=${JSON.stringify(del)}`);
  }

  const existing = readUserData(iconEl);
  const base = existing?.kind === 'section' ? existing.section : null;
  const iconR: Rect = {
    left: Math.round(iconRect.left),
    top: Math.round(iconRect.top),
    right: Math.round(iconRect.right),
    bottom: Math.round(iconRect.bottom),
  };
  const temp: CollapseSection = {
    schemaVersion: base?.schemaVersion ?? SCHEMA_VERSION,
    id,
    iconRect: iconR,
    relativeRect: {
      left: Math.round(zone.left) - iconR.left,
      top: Math.round(zone.top) - iconR.top,
      width: Math.round(zone.right - zone.left),
      height: Math.round(zone.bottom - zone.top),
    },
    collapsedElements: fresh,
    isExpanded: true,
    preservedNums: undefined,
  };

  await expandOne(temp, iconEl, filePath, page);
  await PluginCommAPI.reloadFile();
  dlog(`${LOG} live full redraw section=${id} icon=[${iconR.left},${iconR.top}] zone=[${Math.round(zone.left)},${Math.round(zone.top)},${Math.round(zone.right)},${Math.round(zone.bottom)}]`);
}
