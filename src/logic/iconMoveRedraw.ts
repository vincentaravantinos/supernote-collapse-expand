import { PluginCommAPI, PluginFileAPI, PluginNoteAPI, Rect } from 'sn-plugin-lib';
import { LOG, ZONE_MARGIN, dlog } from '../constants';
import { createBorderRectangle } from '../utils/maskHelpers';
import { stretchZoneToIcon } from '../utils/geometryHelpers';
import { readUserData } from '../utils/userDataManager';
import { acquireBusy, releaseBusy } from './busy';

interface ExpandedEntry {
  iconRect: Rect; // last-known icon position (android), updated after each redraw
  contentBBox: Rect; // absolute content bounding box (android); stable while expanded
}

// Sections expanded in THIS session, with their icon rect + content bbox. Lets
// the motion handler cheaply gate on "did a drag start on a section icon?" and,
// on release, redraw that section's box to follow the moved icon. In-memory only
// — after an app restart it's empty and the live redraw is dormant until the
// section is expanded again (the icon move still works via recollapse→expand).
const expanded = new Map<string, ExpandedEntry>();

export function noteSectionExpanded(id: string, iconRect: Rect, contentBBox: Rect): void {
  expanded.set(id, { iconRect, contentBBox });
}

export function forgetSection(id: string): void {
  expanded.delete(id);
}

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
  if (expanded.size === 0) return;
  for (const [id, e] of expanded) {
    if (rectContains(padded(e.iconRect, GATE_PAD), x, y)) {
      dragCandidateId = id;
      return;
    }
  }
}

// Motion ACTION_UP: if the gesture grabbed an expanded section's icon, redraw
// that section's box to follow the (possibly) moved icon. Only here do we touch
// the SDK, and only for the one candidate section.
export async function onMotionUp(): Promise<void> {
  const id = dragCandidateId;
  dragCandidateId = null;
  if (!id) return;
  const entry = expanded.get(id);
  if (!entry) return;
  if (!acquireBusy()) return; // a button action or another redraw is in flight
  try {
    await redrawSectionBox(id, entry);
  } catch (e) {
    console.error(`${LOG} live redraw failed: ${e}`);
  } finally {
    releaseBusy();
  }
}

async function redrawSectionBox(id: string, entry: ExpandedEntry): Promise<void> {
  const fpRes: any = await PluginCommAPI.getCurrentFilePath();
  const pgRes: any = await PluginCommAPI.getCurrentPageNum();
  if (!fpRes?.success || typeof fpRes.result !== 'string') return;
  if (!pgRes?.success || typeof pgRes.result !== 'number') return;
  const filePath = fpRes.result as string;
  const page = pgRes.result as number;

  // Flush the user's move and dismiss its selection BEFORE reading/mutating
  // (mirrors expand: saveCurrentNote → setLassoBoxState(2) → getElements), so the
  // icon's new rect is visible and we never mutate with a lifted selection.
  await PluginNoteAPI.saveCurrentNote();
  await PluginCommAPI.setLassoBoxState(2);

  const allRes: any = await PluginFileAPI.getElements(page, filePath);
  const all: any[] = allRes?.success && Array.isArray(allRes.result) ? allRes.result : [];

  let iconRect: Rect | null = null;
  const frameNums: number[] = [];
  for (const el of all) {
    const ud = readUserData(el);
    if (!ud) continue;
    if (ud.kind === 'section' && ud.section?.id === id && el?.textBox?.textRect) {
      iconRect = el.textBox.textRect;
    } else if (ud.kind === 'frame' && ud.id === id && typeof el.numInPage === 'number') {
      frameNums.push(el.numInPage);
    }
  }
  if (!iconRect) { expanded.delete(id); return; } // icon gone (recollapsed elsewhere)

  // Did the icon actually move since we last drew the box? (sub-pixel = no)
  const moved =
    Math.abs(iconRect.left - entry.iconRect.left) > 1 ||
    Math.abs(iconRect.top - entry.iconRect.top) > 1;
  if (!moved) {
    expanded.set(id, { ...entry, iconRect });
    return;
  }

  const zone = stretchZoneToIcon(entry.contentBBox, ZONE_MARGIN, iconRect);

  // Move ONLY the outline (CE_FRAME): delete the old frame, insert a new one at
  // the stretched zone. The white fill (CE_MASK) is left untouched so we never
  // re-insert it on top of the content (which would cover the strokes); the fill
  // is fully reshaped at the next recollapse. reloadFile surfaces the change.
  if (frameNums.length > 0) {
    const del: any = await PluginFileAPI.deleteElements(filePath, page, frameNums);
    if (!del?.success) console.error(`${LOG} live redraw deleteElements failed res=${JSON.stringify(del)}`);
  }
  const frame = await createBorderRectangle(zone, page, id);
  if (frame) {
    const ins: any = await PluginFileAPI.insertElements(filePath, page, [frame]);
    if (!ins?.success) console.error(`${LOG} live redraw insertElements failed res=${JSON.stringify(ins)}`);
    try { frame.recycle?.(); } catch { /* ignore */ }
  }
  await PluginCommAPI.reloadFile();

  expanded.set(id, { iconRect, contentBBox: entry.contentBBox });
  dlog(`${LOG} live redraw section=${id} icon=[${Math.round(iconRect.left)},${Math.round(iconRect.top)}] zone=[${Math.round(zone.left)},${Math.round(zone.top)},${Math.round(zone.right)},${Math.round(zone.bottom)}]`);
}
