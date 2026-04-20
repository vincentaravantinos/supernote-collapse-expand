/**
 * Geometry helpers for building point arrays for border rectangles.
 */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Creates a point array for a rectangle.
 * @param rect The rectangle bounds.
 * @returns Array of 5 points (closing back to start).
 */
export function getRectPoints(rect: Rect) {
  return [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
    { x: rect.left, y: rect.top },
  ];
}

/**
 * penType for dashed lines:
 * Based on experimentation in Supernote SDK:
 * Value 4, 6, or 7 typically represent dashed/dotted lines.
 * We'll use 4 as a starting point.
 */
export const DASHED_PEN_TYPE = 4;
export const BORDER_PEN_WIDTH = 100; // SDK units
export const BORDER_PEN_COLOR = 0x50; // Greyish
