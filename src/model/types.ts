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
  // The section's name's bounding box as of the last time it was written.
  // Compared against the name's *current* bbox at each reconciliation
  // checkpoint (next Expand for a collapsed-icon move; each live redraw for
  // an expanded drag) to decide whether the name moved on its own since —
  // if so, it's left untouched instead of being auto-translated to follow
  // the icon. Undefined if the section has never had a name.
  nameSyncedRect?: Rect;
}
