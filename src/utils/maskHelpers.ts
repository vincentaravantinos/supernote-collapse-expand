import { PluginCommAPI, Rect } from 'sn-plugin-lib';
import { CE_FRAME_PREFIX, CE_MASK_PREFIX, ELEMENT_TYPES, LOG } from '../constants';
import { getRectPoints } from './geometryHelpers';

// Fake filled rectangle hiding content under a section's expanded area: the SDK
// only exposes outlined geometry, so we stack concentric polygon rings whose
// thick outlines fill the interior. penColor goes through a native palette that
// accepts only 0x00 black, 0x9D dark gray, 0xC9 light gray, 0xFE white; white
// blends with the page so the area reads blank inside the outline.
const MASK_PEN_COLOR = 0xFE;
const MASK_PEN_TYPE = 10; // penType 0 is rejected by the API
// At penWidth=18000 the stroke renders a ~180-wide band (~90 per side).
const MASK_PEN_WIDTH = 18000;
const VISIBLE_HALF_BAND = 90; // per-side outward extension of the stroke
// Step rings inward by less than the band width so adjacent bands overlap and
// hairline seams disappear. Bump RING_OVERLAP if white spots reappear.
const RING_OVERLAP = 30;
const RING_STEP = 2 * VISIBLE_HALF_BAND - RING_OVERLAP; // = 150

// Thin solid outline at the section boundary (the SDK has no dashed geometry).
// penWidth scales ~100/px, so ~400 ≈ a 4px line.
const BORDER_PEN_COLOR = 0x00;
const BORDER_PEN_TYPE = 10; // solid; penType 0 is rejected
const BORDER_PEN_WIDTH = 400;

// Boundary outline, tagged CE_FRAME so the live redraw can move it without
// disturbing the fill rings.
export async function createBorderRectangle(rect: Rect, page: number, sectionId: string): Promise<any | null> {
  const points = getRectPoints(rect);
  const res: any = await PluginCommAPI.createElement(ELEMENT_TYPES.GEO);
  if (!res?.success || !res.result) {
    console.log(`${LOG} createBorderRectangle FAILED rect=[${rect.left},${rect.top},${rect.right},${rect.bottom}] success=${res?.success} hasResult=${!!res?.result}`);
    return null;
  }
  const el: any = res.result;
  el.geometry = {
    type: 'GEO_polygon',
    points,
    penColor: BORDER_PEN_COLOR,
    penType: BORDER_PEN_TYPE,
    penWidth: BORDER_PEN_WIDTH,
  };
  el.pageNum = page;
  el.userData = CE_FRAME_PREFIX + sectionId;
  return el;
}

async function createMaskRectangle(rect: Rect, page: number, sectionId: string): Promise<any | null> {
  const points = getRectPoints(rect);
  const res: any = await PluginCommAPI.createElement(ELEMENT_TYPES.GEO);
  if (!res?.success || !res.result) {
    console.log(`${LOG} createMaskRectangle FAILED rect=[${rect.left},${rect.top},${rect.right},${rect.bottom}] success=${res?.success} hasResult=${!!res?.result}`);
    return null;
  }
  const el: any = res.result;
  el.geometry = {
    type: 'GEO_polygon',
    points,
    penColor: MASK_PEN_COLOR,
    penType: MASK_PEN_TYPE,
    penWidth: MASK_PEN_WIDTH,
  };
  el.pageNum = page;
  el.userData = CE_MASK_PREFIX + sectionId;
  return el;
}

// A ring whose polygon collapses to ~a point still needs a non-degenerate path
// to render; use a tiny square at the center (the wide stroke covers the gap).
const MIN_POLY_DIM = 2;

export async function createMaskElements(
  rect: Rect,
  page: number,
  sectionId: string,
): Promise<any[]> {
  const w = rect.right - rect.left;
  const h = rect.bottom - rect.top;
  if (w <= 0 || h <= 0) {
    console.log(`${LOG} createMaskElements SKIP empty rect=[${rect.left},${rect.top},${rect.right},${rect.bottom}]`);
    return [];
  }
  // Enough rings that the deepest band reaches the rect's center on the long axis.
  const halfMaxDim = Math.max(w, h) / 2;
  const firstRingReach = 2 * VISIBLE_HALF_BAND;
  const ringsNeeded = halfMaxDim <= firstRingReach
    ? 1
    : 1 + Math.ceil((halfMaxDim - firstRingReach) / RING_STEP);
  const midX = (rect.left + rect.right) / 2;
  const midY = (rect.top + rect.bottom) / 2;
  const result: any[] = [];
  for (let k = 0; k < ringsNeeded; k++) {
    const inset = VISIBLE_HALF_BAND + k * RING_STEP;
    let left = rect.left + inset;
    let right = rect.right - inset;
    let top = rect.top + inset;
    let bottom = rect.bottom - inset;
    // Clamp degenerate dimensions to a tiny segment centered in the rect.
    if (right - left < MIN_POLY_DIM) {
      left = midX - MIN_POLY_DIM / 2;
      right = midX + MIN_POLY_DIM / 2;
    }
    if (bottom - top < MIN_POLY_DIM) {
      top = midY - MIN_POLY_DIM / 2;
      bottom = midY + MIN_POLY_DIM / 2;
    }
    const ringRect: Rect = { left, top, right, bottom };
    const el = await createMaskRectangle(ringRect, page, sectionId);
    if (el) result.push(el);
  }
  // Outline last so it sits on top of the fill rings.
  const border = await createBorderRectangle(rect, page, sectionId);
  if (border) result.push(border);
  return result;
}
