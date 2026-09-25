import { PluginCommAPI, PointUtils, Rect } from 'sn-plugin-lib';
import { CE_FRAME_PREFIX, CE_MASK_PREFIX, ELEMENT_TYPES, LOG } from '../constants';
import { getRectPoints } from './geometryHelpers';
import { PageSize } from './elementSerializer';

// Fake filled rectangle hiding content under a section's expanded area: the SDK
// only exposes outlined shapes, so we stack concentric closed-path rings whose
// thick outlines fill the interior. penColor goes through a native palette that
// accepts only 0x00 black, 0x9D dark gray, 0xC9 light gray, 0xFE white; white
// blends with the page so the area reads blank inside the outline.
//
// CR-007/REQ-300: built as STROKE elements, not GEO_polygon — a GEO_polygon's
// full bounding box counts as "hit" by a lasso regardless of visible ink,
// which let any lasso inside the zone sweep in the whole mask/border (B-021).
// A STROKE is hit-tested by its actually-rendered pixels instead, confirmed
// on-device: a near-white stroke became fully unselectable while a lasso
// touching both it and separate real content selected only the real content.
const MASK_PEN_COLOR = 0xFE;
const MASK_PEN_TYPE = 10; // penType 0 is rejected by the API
// At thickness=18000 the stroke renders a ~180-wide band (~90 per side) —
// carried over from the GEO_polygon penWidth value as a starting point; STROKE's
// thickness scale isn't confirmed to match penWidth's, recalibrate if the fill
// reads as the wrong width on-device.
const MASK_THICKNESS = 18000;
const VISIBLE_HALF_BAND = 90; // per-side outward extension of the stroke
// Step rings inward by less than the band width so adjacent bands overlap and
// hairline seams disappear. Bump RING_OVERLAP if white spots reappear.
const RING_OVERLAP = 30;
const RING_STEP = 2 * VISIBLE_HALF_BAND - RING_OVERLAP; // = 150

// Thin solid outline at the section boundary (the SDK has no dashed geometry).
// thickness scales ~100/px on GEO_polygon's penWidth; carried over as a
// starting point for STROKE's thickness, same recalibration caveat as above.
const BORDER_PEN_COLOR = 0x00;
const BORDER_PEN_TYPE = 10; // solid; penType 0 is rejected
const BORDER_THICKNESS = 400;

// Constant per-point pressure for a synthesized stroke (there's no real pen
// gesture behind these). Leading suspect for why an earlier hand-built stroke
// (no pressures set at all) failed to render during this feature's B-021
// investigation — set explicitly here rather than left empty.
const SYNTHETIC_PRESSURE = 1.0;

// Convert a Rect's corners (android page px, as getRectPoints/GEO_polygon used
// directly) to the coordinate space STROKE points need. maxX/maxY are set to
// the page's own real max, so no additional rescaling is needed downstream
// (mirrors how buildStroke's own rescale becomes a no-op when maxX/maxY
// already match pageMaxX/pageMaxY).
function rectToStrokePoints(rect: Rect, pageSize: PageSize): { x: number; y: number }[] {
  return getRectPoints(rect).map((p) => {
    const emr = PointUtils.androidPoint2Emr(p, pageSize);
    return { x: Math.round(emr.x), y: Math.round(emr.y) };
  });
}

async function createStrokeRectangle(
  rect: Rect,
  page: number,
  pageSize: PageSize,
  userData: string,
  penColor: number,
  penType: number,
  thickness: number,
  failureLabel: string,
): Promise<any | null> {
  const res: any = await PluginCommAPI.createElement(ELEMENT_TYPES.STROKE);
  if (!res?.success || !res.result) {
    console.log(`${LOG} ${failureLabel} FAILED rect=[${rect.left},${rect.top},${rect.right},${rect.bottom}] success=${res?.success} hasResult=${!!res?.result}`);
    return null;
  }
  const el: any = res.result;
  el.thickness = thickness;
  el.pageNum = page;
  el.maxX = PointUtils.getRealMaxX(pageSize);
  el.maxY = PointUtils.getRealMaxY(pageSize);
  if (!el.stroke) el.stroke = {};
  el.stroke.penColor = penColor;
  el.stroke.penType = penType;
  el.userData = userData;
  const points = rectToStrokePoints(rect, pageSize);
  await el.stroke.points.setRange(0, points.length, points);
  await el.stroke.pressures.setRange(0, points.length, points.map(() => SYNTHETIC_PRESSURE));
  return el;
}

// Boundary outline, tagged CE_FRAME so the live redraw can move it without
// disturbing the fill rings.
export async function createBorderRectangle(rect: Rect, page: number, sectionId: string, pageSize: PageSize): Promise<any | null> {
  return createStrokeRectangle(rect, page, pageSize, CE_FRAME_PREFIX + sectionId, BORDER_PEN_COLOR, BORDER_PEN_TYPE, BORDER_THICKNESS, 'createBorderRectangle');
}

async function createMaskRectangle(rect: Rect, page: number, sectionId: string, pageSize: PageSize): Promise<any | null> {
  return createStrokeRectangle(rect, page, pageSize, CE_MASK_PREFIX + sectionId, MASK_PEN_COLOR, MASK_PEN_TYPE, MASK_THICKNESS, 'createMaskRectangle');
}

// A ring whose polygon collapses to ~a point still needs a non-degenerate path
// to render; use a tiny square at the center (the wide stroke covers the gap).
const MIN_POLY_DIM = 2;

export async function createMaskElements(
  rect: Rect,
  page: number,
  sectionId: string,
  pageSize: PageSize,
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
    const el = await createMaskRectangle(ringRect, page, sectionId, pageSize);
    if (el) result.push(el);
  }
  // Outline last so it sits on top of the fill rings.
  const border = await createBorderRectangle(rect, page, sectionId, pageSize);
  if (border) result.push(border);
  return result;
}
