import { TAP_MAX_PX } from '../constants';

// Shared DOWN-point tracker: the live-redraw drag detector (iconMoveRedraw)
// and the finger-tap shortcut (iconTapToggle) both react to the same motion
// stream and need to classify a gesture as "tap" vs "drag" by how far it
// moved between DOWN and UP. One shared tracker avoids each keeping its own
// duplicate down-point bookkeeping.
let downX = 0;
let downY = 0;

// A lone finger (not the pen, not a multi-finger gesture).
export function isSingleFinger(toolType: number | undefined, pointerCount: number | undefined): boolean {
  return toolType === 1 && pointerCount === 1;
}

export function noteGestureDown(x: number, y: number): void {
  downX = x;
  downY = y;
}

export function isTapDistance(x: number, y: number): boolean {
  return Math.abs(x - downX) < TAP_MAX_PX && Math.abs(y - downY) < TAP_MAX_PX;
}

// The raw down-to-up delta, for a finger drag that needs to synthesize
// a moved position itself (a finger never actually relocates a page element).
export function gestureDelta(x: number, y: number): { dx: number; dy: number } {
  return { dx: x - downX, dy: y - downY };
}
