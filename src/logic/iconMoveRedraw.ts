import { PluginCommAPI, PluginFileAPI, PluginManager, PluginNoteAPI, Rect } from 'sn-plugin-lib';
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

// We gate icon-move on whether the DOWN landed near the icon. The 50px icon is a
// small target and grabs land a couple dozen px off its edge, so the pad is
// generous. A wide pad also catches lasso-selects starting near the icon, but
// that's harmless: redrawSectionBox reads-before-dismiss and only acts on a real
// move, so a false hit just does a cheap getElements and returns.
const GATE_PAD = 30;

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

// The plugin host does NOT pump the JS event loop while idle — timers only fire
// when a native event or an in-flight await ticks the runtime. So we can't defer
// the redraw through a setTimeout debounce (it would never fire after the pen
// lifts); we run it directly from the UP event and coalesce rapid drags with the
// busy guard + a re-run flag instead.
let rerunId: string | null = null;

async function kickRedraw(id: string): Promise<void> {
  if (!getExpandedEntry(id)) return;
  if (!acquireBusy()) {
    // A redraw or a button op is in flight; remember to redraw once it frees up.
    // The in-flight op's finally is on a pumped loop, so the re-run actually runs.
    rerunId = id;
    return;
  }
  try {
    do {
      const target = rerunId ?? id;
      rerunId = null;
      if (!getExpandedEntry(target)) continue;
      try {
        await redrawSectionBox(target);
      } catch (e) {
        console.error(`${LOG} live redraw failed: ${e}`);
      }
    } while (rerunId); // another drag landed while we were redrawing — coalesce it
  } finally {
    releaseBusy();
  }
}

// ACTION_DOWN: in-memory gate (no SDK call) — did this touch start near one of
// our expanded sections' icons? If not, the UP handler no-ops.
export function onMotionDown(x: number, y: number): void {
  dragCandidateId = null;
  downX = x;
  downY = y;
  if (expandedCount() === 0) return;
  for (const [id, e] of expandedEntries()) {
    if (rectContains(padded(e.iconRect, GATE_PAD), x, y)) {
      dragCandidateId = id;
      return;
    }
  }
}

// ACTION_UP: if the gesture grabbed an expanded section's icon and the finger
// actually moved (not a tap/select), redraw that section.
export function onMotionUp(x: number, y: number): void {
  const id = dragCandidateId;
  dragCandidateId = null;
  if (!id) return;
  if (Math.abs(x - downX) < TAP_MAX_PX && Math.abs(y - downY) < TAP_MAX_PX) return; // tap/select
  if (!getExpandedEntry(id)) return;
  void kickRedraw(id);
}

// Full live redraw: re-fill the mask AND re-place the strokes at the stretched
// zone. Re-serializes the on-page strokes per drag (rare op). Reuses expandOne so
// z-order and stroke links match a normal expand; one reloadFile, no flash.
async function redrawSectionBox(id: string): Promise<void> {
  const entry = getExpandedEntry(id);
  if (!entry) return;

  const fpRes: any = await PluginCommAPI.getCurrentFilePath();
  const pgRes: any = await PluginCommAPI.getCurrentPageNum();
  if (!fpRes?.success || typeof fpRes.result !== 'string') return;
  if (!pgRes?.success || typeof pgRes.result !== 'number') return;
  const filePath = fpRes.result as string;
  const page = pgRes.result as number;

  // Flush, then READ before dismissing: only setLassoBoxState (which cancels the
  // selection) if the icon actually moved. saveCurrentNote surfaces a real drag
  // to getElements, so a move reads moved=true while a select leaves the icon put
  // (moved=false → return untouched). This is what lets selecting and moving
  // coexist — the gate alone can't tell them apart.
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

  // Show the busy overlay for the rebuild (same heavy path as a normal expand).
  // Only past the moved check, so a tap/select never flashes it; closed in the
  // finally regardless of which early return fires.
  let viewShown = false;
  try {
    await PluginManager.showPluginView();
    viewShown = true;
  } catch (e) {
    dlog(`${LOG} live redraw showPluginView failed: ${e}`);
  }
  try {
    // Re-serialize the current on-page content so we can rebuild it above a fresh
    // fill. resolveLinkMemberIndices keeps stroke links.
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

    // Delete the content + fill + outline, then re-expand in place. The temp
    // section is anchored to the CURRENT icon (emrDelta=0 ⇒ content rebuilds where
    // it is); relativeRect places the mask at the stretched zone.
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
      // Carry preservedNums forward; recapturing would misfile these (already
      // on-page) strokes as pre-existing.
      preservedNums: base?.preservedNums,
    };

    await expandOne(temp, iconEl, filePath, page); // capturePreserved defaults false
    await PluginCommAPI.reloadFile();
    dlog(`${LOG} live full redraw section=${id} icon=[${iconR.left},${iconR.top}] zone=[${Math.round(zone.left)},${Math.round(zone.top)},${Math.round(zone.right)},${Math.round(zone.bottom)}]`);
  } finally {
    if (viewShown) {
      try { await PluginManager.closePluginView(); } catch (e) { dlog(`${LOG} live redraw closePluginView failed: ${e}`); }
    }
  }
}
