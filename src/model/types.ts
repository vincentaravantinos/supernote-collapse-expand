export interface CollapsedElement {
  uuid: string;       // original element UUID
  type: number;       // ElementType value
  numInPage: number;  // original render index within the page (for Z-order restoration)
  serializedData: string; // compact JSON string of the element's data
}

export interface CollapseSection {
  schemaVersion: number;

  // Icon position recorded at collapse time (pixel coords).
  originalIconOrigin: { x: number; y: number };

  // Content rect stored as offsets from originalIconOrigin (pixel coords).
  relativeRect: { left: number; top: number; width: number; height: number };

  collapsedElements: CollapsedElement[];       // original elements, serialized at collapse time
  overlapElements: CollapsedElement[] | null;  // elements found in the content area at expand time

  isExpanded: boolean;
  borderElementUuid: string | null; // UUID of the dashed border geometry; non-null when expanded
}

export interface BorderUserData {
  type: 'collapseExpandBorder';
  iconElementUuid: string; // UUID of the corresponding "+" icon element
}
