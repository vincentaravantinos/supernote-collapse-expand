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

// A drag that GRABS the icon (DOWN on it) moves it; we gate on whether the DOWN
// landed on (near) the icon. The 50px icon is a small target and grabs routinely
// land a couple dozen pixels off its edge, so the pad is generous. A wide pad
// also catches lasso-selects that start near the icon — but that is now HARMLESS:
// redrawSectionBox reads before dismissing and only setLassoBoxState(2)s when the
// icon actually moved, so a false-positive gate hit on a select just does a
// cheap getElements and returns without disturbing the selection. (The pad used
// to be tiny precisely to avoid catching selects; read-before-dismiss made that
// caution redundant.)
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

// IMPORTANT: the plugin host does NOT pump the JS event loop while idle — a
// setTimeout/setInterval callback only fires when a native event or an in-flight
// `await` ticks the runtime (verified with a heartbeat probe that stayed silent
// at rest and ticked only during an active operation). So we must NOT defer the
// redraw through a timer: after the pen lifts and the user stops touching,
// nothing would ever fire it. Instead we run the redraw directly from the UP
// event (which IS pumped), and coalesce rapid drags with the shared busy guard
// plus a re-run flag — no timer involved. The "don't dismiss the user's
// selection" guarantee is provided by redrawSectionBox's read-before-dismiss
// (it only setLassoBoxState(2)s when the icon actually moved), not by debouncing.
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

// Motion ACTION_DOWN: pure in-memory gate — did this touch start on (near) one of
// our expanded sections' icons? No SDK call. If not, the UP handler no-ops.
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

// Motion ACTION_UP: if the gesture grabbed an expanded section's icon, redraw
// that section if the icon moved. Only here do we touch the SDK.
export function onMotionUp(x: number, y: number): void {
  const id = dragCandidateId;
  dragCandidateId = null;
  if (!id) return;
  // Tap / select (finger barely moved): do nothing — touching the SDK here would
  // dismiss the user's selection. Only an actual drag runs a redraw.
  if (Math.abs(x - downX) < TAP_MAX_PX && Math.abs(y - downY) < TAP_MAX_PX) return;
  if (!getExpandedEntry(id)) return;
  void kickRedraw(id);
}

// Full live redraw: re-fill the white mask AND re-place the strokes at the
// stretched zone, not just the outline. Costs a re-serialize of the on-page
// strokes per drag (accepted: rare op). Reuses expandOne so mask/content z-order
// and stroke links are handled the same way as a normal expand; one reloadFile
// (no collapsed flash). A busy overlay covers the rebuild (see PluginManager
// calls below).
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

  // The rebuild below is the same heavy path as a normal expand (re-serialize +
  // re-insert + reloadFile), so show the busy overlay for it too. Only here —
  // past the moved check — so a tap/select that didn't move the icon never flashes
  // it. Closed in the finally regardless of which early return fires.
  let viewShown = false;
  try {
    await PluginManager.showPluginView();
    viewShown = true;
  } catch (e) {
    dlog(`${LOG} live redraw showPluginView failed: ${e}`);
  }
  try {
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
  } finally {
    if (viewShown) {
      try { await PluginManager.closePluginView(); } catch (e) { dlog(`${LOG} live redraw closePluginView failed: ${e}`); }
    }
  }
}
