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
  // --- stroke links (category 1) only ---
  // Persisted: indexes into the section's `collapsedElements` of the strokes
  // that form this link. On expand the link is rebuilt pointing at those
  // strokes' NEW page nums. Resolved by `resolveLinkMemberIndices`.
  memberIndices?: number[];
  // Transient: the raw on-page `controlTrailNums` captured at serialize time.
  // Converted to `memberIndices` (and deleted) by `resolveLinkMemberIndices`;
  // never persisted in the icon userData.
  srcControlNums?: number[];
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
  id: string;
  iconRect: Rect;
  relativeRect: RelativeRect;
  collapsedElements: CollapsedElement[];
  isExpanded: boolean;
  // numInPage of pre-existing untagged elements that were sitting under the
  // section when it was expanded. Recollapse uses this to skip them in the
  // "absorb untagged strokes from contentRect" step. Set on expand, cleared
  // on recollapse.
  preservedNums?: number[];
}
