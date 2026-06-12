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
export function stretchZoneToIcon(contentBBox: Rect, margin: number, icon: Rect): Rect {
  const r = {
    left: contentBBox.left - margin,
    top: contentBBox.top - margin,
    right: contentBBox.right + margin,
    bottom: contentBBox.bottom + margin,
  };
  return {
    left: icon.right <= r.left ? icon.right : r.left,
    top: icon.bottom <= r.top ? icon.bottom : r.top,
    right: icon.left >= r.right ? icon.left : r.right,
    bottom: icon.top >= r.bottom ? icon.top : r.bottom,
  };
}
