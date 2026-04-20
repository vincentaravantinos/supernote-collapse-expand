import { Rect } from './geometryHelpers';

export function union(r1: Rect, r2: Rect): Rect {
  return {
    left: Math.min(r1.left, r2.left),
    top: Math.min(r1.top, r2.top),
    right: Math.max(r1.right, r2.right),
    bottom: Math.max(r1.bottom, r2.bottom),
  };
}

export function containsPoint(rect: Rect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export function translateRect(rect: Rect, dx: number, dy: number): Rect {
  return {
    left: rect.left + dx,
    top: rect.top + dy,
    right: rect.right + dx,
    bottom: rect.bottom + dy,
  };
}
