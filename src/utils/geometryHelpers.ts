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
    // B-022: clamp the shift so it can never push a zone edge past the
    // content bbox's own edge (r) — containment of the content always wins
    // over fully clearing the icon. zone.left <= r.left and zone.right >=
    // r.right always hold here (symmetric for top/bottom), so these bounds
    // are always on the correct side of zero; the clamp only ever reduces
    // the shift's magnitude, never flips its direction. In the extreme case
    // (icon dragged inside the content's own footprint, zone already at r),
    // this reduces the shift to exactly 0 and the icon may end up
    // overlapping the zone/mask instead — the lesser visual problem.
    if (Math.abs(iconCx - zoneCx) >= Math.abs(iconCy - zoneCy)) {
      shiftDx = iconCx < zoneCx
        ? Math.min((icon.right + margin) - zone.left, r.left - zone.left)
        : Math.max((icon.left - margin) - zone.right, r.right - zone.right);
      zone.left += shiftDx;
      zone.right += shiftDx;
    } else {
      shiftDy = iconCy < zoneCy
        ? Math.min((icon.bottom + margin) - zone.top, r.top - zone.top)
        : Math.max((icon.top - margin) - zone.bottom, r.bottom - zone.bottom);
      zone.top += shiftDy;
      zone.bottom += shiftDy;
    }
  }
  return { zone, shiftDx, shiftDy };
}

// B-022: when the zone's own shift was clamped to protect content containment,
// the icon can still end up overlapping the zone (the guarantee that used to
// keep it clear was traded away in favor of never excluding content). Project
// the icon out to just outside the zone's nearest edge instead of leaving it
// hidden underneath — "nearest edge" = whichever of the four directions needs
// the smallest move to clear the zone. Returns `icon` unchanged if it doesn't
// overlap `zone` at all.
export function projectIconOutsideZone(icon: Rect, zone: Rect, margin: number): Rect {
  if (!rectsOverlap(icon, zone)) return icon;
  const w = icon.right - icon.left;
  const h = icon.bottom - icon.top;
  const penLeft = icon.right - zone.left; // move icon left to clear via zone's left edge
  const penRight = zone.right - icon.left; // move icon right to clear via zone's right edge
  const penTop = icon.bottom - zone.top; // move icon up to clear via zone's top edge
  const penBottom = zone.bottom - icon.top; // move icon down to clear via zone's bottom edge
  const minPen = Math.min(penLeft, penRight, penTop, penBottom);
  if (minPen === penLeft) {
    return { left: zone.left - margin - w, top: icon.top, right: zone.left - margin, bottom: icon.bottom };
  }
  if (minPen === penRight) {
    return { left: zone.right + margin, top: icon.top, right: zone.right + margin + w, bottom: icon.bottom };
  }
  if (minPen === penTop) {
    return { left: icon.left, top: zone.top - margin - h, right: icon.right, bottom: zone.top - margin };
  }
  return { left: icon.left, top: zone.bottom + margin, right: icon.right, bottom: zone.bottom + margin + h };
}
