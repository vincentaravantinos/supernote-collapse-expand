import type { Point, Rect } from 'sn-plugin-lib';

export interface RelativeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SerializedStroke {
  kind: 'stroke';
  thickness: number;
  penColor: number;
  penType: number;
  points: Point[];
  pressures: number[];
  emrPointAxis?: number;
  factorResize?: number;
  layerNum?: number;
  maxX?: number;
  maxY?: number;
}

export interface SerializedText {
  kind: 'text';
  type: number; // 500 | 501 | 502
  textContentFull: string;
  textRect: Rect;
  fontSize: number;
  textAlign: number;
  textBold: number;
  textItalics: number;
  textFrameWidthType: number;
  textFrameStyle: number;
  textEditable: number;
}

export interface SerializedLink {
  kind: 'link';
  category: number;
  rect: Rect;
  style: number;
  linkType: number;
  destPath: string;
  destPage: number;
  fontSize: number;
  fullText: string;
  showText: string;
  italic: number;
}

export interface SerializedGeometry {
  kind: 'geometry';
  geoType: string;
  points: Point[];
  penColor: number;
  penType: number;
  penWidth: number;
}

export type SerializedElement =
  | SerializedStroke
  | SerializedText
  | SerializedLink
  | SerializedGeometry;

export interface CollapsedElement {
  numInPage: number; // preserved for Z-order on restore
  data: SerializedElement;
}

export interface CollapseSection {
  schemaVersion: number;
  iconRect: Rect;
  relativeRect: RelativeRect;
  collapsedElements: CollapsedElement[];
  isExpanded: boolean;
  borderNumInPage?: number;
}
