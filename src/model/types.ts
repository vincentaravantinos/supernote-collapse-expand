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
  layerNum?: number;
  // Coordinate space the points live in. Restoring without these makes the
  // native side default to the page's maxX/maxY, which scales the stroke.
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

export interface HiddenElement {
  data: SerializedElement;
  // Original userData string preserved verbatim, so other sections' icons (or
  // any tagged element that happened to sit under the contentRect) round-trip
  // intact when restored.
  userData?: string;
}

export interface CollapseSection {
  schemaVersion: number;
  id: string;
  iconRect: Rect;
  relativeRect: RelativeRect;
  collapsedElements: CollapsedElement[];
  // Content that lived inside the section's rectangle at expand time. Hidden
  // during expansion, restored at original page coordinates on recollapse.
  hiddenElements?: HiddenElement[];
  isExpanded: boolean;
}
