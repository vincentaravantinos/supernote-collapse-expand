/**
 * Supernote coordinate system helpers.
 * Usually, there is a fixed ratio between EMR (native) and Screen (pixel) coordinates.
 * For A5X/A6X, it's often 0.1 or similar, but the SDK APIs usually return pixels
 * or have specific conversion functions.
 *
 * Based on the prompt: "All translation math (dx, dy) must use the full floating-point values".
 */

export const EMR_TO_PIXEL = 1.0; // Placeholder: Adjust if the SDK uses a specific scale

export function emrToPixel(val: number): number {
  return val * EMR_TO_PIXEL;
}

export function pixelToEmr(val: number): number {
  return val / EMR_TO_PIXEL;
}

export interface Point {
  x: number;
  y: number;
}

export function translatePoint(p: Point, dx: number, dy: number): Point {
  return {
    x: p.x + dx,
    y: p.y + dy,
  };
}
