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

// Selecting the icon is ALWAYS done by lassoing — a drag that STARTS OUTSIDE the
// icon and loops around it (standard, every time). Moving it is a drag that
// GRABS the icon (DOWN on it). So the gate must fire only when DOWN lands on the
// icon itself; any DOWN that starts outside is a select and must be ignored (or
// we'd dismiss the user's selection — the redraw has to setLassoBoxState to
// commit/detect a move). Keep the pad to bare touch slop on the 50px icon.
const GATE_PAD = 8;

function padded(r: Rect, pad: number): Rect {
  return { left: r.left - pad, top: r.top - pad, right: r.right + pad, bottom: r.bottom + pad };
}

// Section whose icon the current gesture grabbed (set on DOWN, consumed on UP),
// and the DOWN point (to tell a tap/select from a drag on UP).
let dragCandidateId: string | null = null;
let downX = 0;
let downY = 0;

// A gesture whose finger moved less than this is a tap/select, not a drag — it
// must NOT trigger the redraw (which would dismiss the user's selection).
const TAP_MAX_PX = 16;

// Debounce: a drag schedules a redraw rather than running it inline. Any further
// touch (DOWN) or drag (UP) restarts the timer, so the (slow) redraw only fires
// once the user has stopped touching for this long — coalescing rapid moves and,
// crucially, never running its setLassoBoxState/reloadFile in the middle of the
// user's next gesture (which was dismissing selections).
const REDRAW_DEBOUNCE_MS = 600;
let pendingRedrawId: string | null = null;
let redrawTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRedraw(id: string): void {
  pendingRedrawId = id;
  if (redrawTimer) clearTimeout(redrawTimer);
  redrawTimer = setTimeout(runPendingRedraw, REDRAW_DEBOUNCE_MS);
}

function bumpRedrawTimer(): void {
  if (redrawTimer) {
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(runPendingRedraw, REDRAW_DEBOUNCE_MS);
  }
}

async function runPendingRedraw(): Promise<void> {
  redrawTimer = null;
  const id = pendingRedrawId;
  if (!id) return;
  if (!getExpandedEntry(id)) { pendingRedrawId = null; return; }
  if (!acquireBusy()) {
    // Something's running — try again shortly instead of dropping the redraw.
    redrawTimer = setTimeout(runPendingRedraw, 300);
    return;
  }
  pendingRedrawId = null;
  try {
    await redrawSectionBox(id);
  } catch (e) {
    console.error(`${LOG} live redraw failed: ${e}`);
  } finally {
    releaseBusy();
  }
}

// Motion ACTION_DOWN: pure in-memory gate — did this touch start on (near) one of
// our expanded sections' icons? No SDK call. If not, the UP handler no-ops.
export function onMotionDown(x: number, y: number): void {
  dragCandidateId = null;
  downX = x;
  downY = y;
  bumpRedrawTimer(); // any new touch delays a pending redraw until the user settles
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
export function onMotionUp(x: number, y: number): void {
  const id = dragCandidateId;
  dragCandidateId = null;
  if (!id) return;
  // Tap / select (finger barely moved): do nothing — touching the SDK here would
  // dismiss the user's selection. Only an actual drag schedules a redraw.
  if (Math.abs(x - downX) < TAP_MAX_PX && Math.abs(y - downY) < TAP_MAX_PX) return;
  if (!getExpandedEntry(id)) return;
  scheduleRedraw(id);
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

  // Flush, then READ before dismissing — only dismiss (setLassoBoxState, which
  // would cancel the user's selection) if the icon ACTUALLY moved. saveCurrentNote
  // surfaces a real drag to getElements (verified on-device), so a genuine move
  // reads moved=true; a select gesture (even one that started on the icon) leaves
  // the icon put → moved=false → we return without ever touching the selection.
  // This is what lets selecting and moving coexist (the gate alone can't tell
  // them apart — both can start on the icon).
  await PluginNoteAPI.saveCurrentNote();

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
  if (!iconEl || !iconRect) return; // icon gone (recollapsed elsewhere)

  // Did the icon actually move since we last drew the box? (sub-pixel = no)
  const moved =
    Math.abs(iconRect.left - entry.iconRect.left) > 1 ||
    Math.abs(iconRect.top - entry.iconRect.top) > 1;
  if (!moved) {
    noteSectionExpanded(id, iconRect, entry.contentBBox);
    return;
  }

  // Confirmed move — NOW dismiss the selection (commit) before mutating.
  await PluginCommAPI.setLassoBoxState(2);

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
    // Carry preservedNums forward (don't recapture — these strokes are already on
    // the page, so a recapture would misfile new strokes as pre-existing).
    preservedNums: base?.preservedNums,
  };

  await expandOne(temp, iconEl, filePath, page); // live redraw: capturePreserved defaults false
  await PluginCommAPI.reloadFile();
  dlog(`${LOG} live full redraw section=${id} icon=[${iconR.left},${iconR.top}] zone=[${Math.round(zone.left)},${Math.round(zone.top)},${Math.round(zone.right)},${Math.round(zone.bottom)}]`);
}
