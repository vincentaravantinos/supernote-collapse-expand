import { Point, Rect } from 'sn-plugin-lib';

// Overlap = shared area; touching edges don't count (strict inequalities).
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

export function padded(r: Rect, pad: number): Rect {
  return { left: r.left - pad, top: r.top - pad, right: r.right + pad, bottom: r.bottom + pad };
}

export function getRectPoints(rect: Rect): Point[] {
  return [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
    { x: rect.left, y: rect.top },
  ];
}

// Content bbox padded by `margin`, then stretched on any side the icon lies
// beyond, so the zone reaches the icon's near edge (the icon stays just
// outside). Lets a moved icon end up sitting at the area's edge.
//
// If the icon isn't cleanly outside the padded content on any single axis
// (e.g. content now includes ink drawn on/near the icon itself), none of
// the four stretches above fire and the zone can still overlap the icon.
// In that case, the whole zone is translated away from the icon on
// whichever axis the icon's center is more displaced on — shifting both
// edges by the same delta keeps the zone's width/height unchanged (so it
// still fully contains the content, unlike moving just the near edge,
// which would shrink and clip it). `shiftDx`/`shiftDy` report that delta
// (0/0 if no shift was needed) so the caller can move the actual content
// strokes by the same amount — see BUGS/B-011.md / CollapseSection.contentShift.
export function stretchZoneToIcon(
  contentBBox: Rect,
  margin: number,
  icon: Rect,
): { zone: Rect; shiftDx: number; shiftDy: number } {
  const r = {
    left: contentBBox.left - margin,
    top: contentBBox.top - margin,
    right: contentBBox.right + margin,
    bottom: contentBBox.bottom + margin,
  };
  const zone = {
    left: icon.right <= r.left ? icon.right : r.left,
    top: icon.bottom <= r.top ? icon.bottom : r.top,
    right: icon.left >= r.right ? icon.left : r.right,
    bottom: icon.top >= r.bottom ? icon.top : r.bottom,
  };
  let shiftDx = 0;
  let shiftDy = 0;
  if (rectsOverlap(icon, zone)) {
    const iconCx = (icon.left + icon.right) / 2;
    const iconCy = (icon.top + icon.bottom) / 2;
    const zoneCx = (zone.left + zone.right) / 2;
    const zoneCy = (zone.top + zone.bottom) / 2;
    if (Math.abs(iconCx - zoneCx) >= Math.abs(iconCy - zoneCy)) {
      shiftDx = iconCx < zoneCx
        ? (icon.right + margin) - zone.left
        : (icon.left - margin) - zone.right;
      zone.left += shiftDx;
      zone.right += shiftDx;
    } else {
      shiftDy = iconCy < zoneCy
        ? (icon.bottom + margin) - zone.top
        : (icon.top - margin) - zone.bottom;
      zone.top += shiftDy;
      zone.bottom += shiftDy;
    }
  }
  return { zone, shiftDx, shiftDy };
}
