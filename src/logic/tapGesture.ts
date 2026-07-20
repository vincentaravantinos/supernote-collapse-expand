import { TAP_MAX_PX } from '../constants';

// Shared DOWN-point tracker: the live-redraw drag detector (iconMoveRedraw)
// and the finger-tap shortcut (iconTapToggle) both react to the same motion
// stream and need to classify a gesture as "tap" vs "drag" by how far it
// moved between DOWN and UP. One shared tracker avoids each keeping its own
// duplicate down-point bookkeeping.
let downX = 0;
let downY = 0;

export function noteGestureDown(x: number, y: number): void {
  downX = x;
  downY = y;
}

export function isTapDistance(x: number, y: number): boolean {
  return Math.abs(x - downX) < TAP_MAX_PX && Math.abs(y - downY) < TAP_MAX_PX;
}
