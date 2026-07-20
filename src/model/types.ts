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
  // EMR coordinate space of the points. Without these, restore defaults to the
  // page's maxX/maxY and the stroke is rescaled.
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
  // Persisted indexes into the section's `collapsedElements` of the member
  // strokes. Page nums don't survive the round-trip, so on expand the link is
  // rebuilt against the strokes' NEW nums. Resolved by resolveLinkMemberIndices.
  memberIndices?: number[];
  // Transient raw on-page controlTrailNums captured at serialize time; converted
  // to memberIndices (and deleted) by resolveLinkMemberIndices, never persisted.
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
  // numInPage of every untagged element on the page at expand time (pre-existing
  // content). Recollapse uses it to tell new strokes drawn on the section (num
  // not listed) from pre-existing content, absorbing only the new. Set on
  // expand, cleared on recollapse.
  preservedNums?: number[];
  // Extra shift (beyond the icon's own movement) to apply to the restored
  // content at the next Expand only. Set by Recollapse when the section's
  // area had to be moved to stop covering the icon (see BUGS/B-011.md) —
  // content strokes move as one rigid group, preserving their layout
  // relative to each other; only their position relative to the icon
  // changes, which is fine since the user didn't drag the icon to cause
  // this. Consumed and cleared on the next Expand.
  contentShift?: { dx: number; dy: number };
}
