import { Point, Rect } from '../model/types';

export function getRectPoints(rect: Rect): Point[] {
  return [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
    { x: rect.left, y: rect.top },
  ];
}

export const BORDER_PEN_TYPE = 10;
export const BORDER_PEN_WIDTH = 500;
export const BORDER_PEN_COLOR = 0x9D;
