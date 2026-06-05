import { PluginCommAPI, Rect } from 'sn-plugin-lib';
import { CE_MASK_PREFIX, ELEMENT_TYPES, LOG } from '../constants';
import { getRectPoints } from './geometryHelpers';

// Fake "filled rectangle" used to hide content sitting under a section's
// expanded area. The SDK only exposes outlined geometry, so we draw a stack
// of concentric polygon rings that nest inward — each ring's thick outline
// covers a band, and stacked rings fill the interior.
// Swap the body of createMaskElements once the SDK provides a real filled shape.
// penColor goes through a native palette; only specific values are accepted.
const MASK_PEN_COLOR = 0xC9;
const MASK_PEN_TYPE = 10; // penType 0 is rejected by the API
// Empirical: at penWidth=18000 the stroke renders a visible band ~180 wide
// (~90 either side of the geometric path). Pen sits well below the SDK's
// saturation point, so coverage stays predictable across rect sizes.
const MASK_PEN_WIDTH = 18000;
const VISIBLE_HALF_BAND = 90; // per-side outward extension of the stroke
// Each ring's stroke band is 2 * VISIBLE_HALF_BAND wide. Step adjacent rings
// inward by less than that so neighboring bands overlap by RING_OVERLAP and
// hairline seams disappear. Bump RING_OVERLAP if white spots reappear.
const RING_OVERLAP = 30;
const RING_STEP = 2 * VISIBLE_HALF_BAND - RING_OVERLAP; // = 150

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

// When a ring's geometric polygon would collapse to a point or less, we
// still need a non-degenerate path so the SDK actually renders the stroke.
// Use a tiny square at the rect's center — the 180-wide stroke envelope
// dominates and covers any small remaining gap.
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
  // Ring 0 covers from the rect edge inward by 2 * VISIBLE_HALF_BAND. Each
  // additional ring extends coverage inward by RING_STEP (less than the
  // band width because of the overlap). Need enough rings so the deepest
  // band reaches the rect's center on the longest axis.
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
  return result;
}
