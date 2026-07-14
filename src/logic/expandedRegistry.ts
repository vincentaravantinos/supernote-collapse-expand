import { Rect } from 'sn-plugin-lib';

export interface ExpandedEntry {
  iconRect: Rect; // last-known icon position, updated after each redraw
  contentBBox: Rect; // absolute content bbox at last (re)expand
  iconNum?: number; // the icon's numInPage, so recollapse can fetch it directly
}

// Sections expanded in THIS session. The motion handler (iconMoveRedraw) reads
// this to gate on "did a drag grab an expanded section's icon?" and to redraw on
// release. In-memory only: after an app restart it's empty. index.js calls
// expandAction's rehydrateExpandedRegistry once at startup to reseed it for
// whatever page is open at that moment (best-effort, page-scoped — a section
// expanded on a different page stays dormant until visited). Kept in its own
// module so both expandAction (registers) and iconMoveRedraw (reads + triggers
// expandOne) can use it without an import cycle.
const expanded = new Map<string, ExpandedEntry>();

export function noteSectionExpanded(id: string, iconRect: Rect, contentBBox: Rect, iconNum?: number): void {
  expanded.set(id, { iconRect, contentBBox, iconNum });
}

export function forgetSection(id: string): void {
  expanded.delete(id);
}

export function getExpandedEntry(id: string): ExpandedEntry | undefined {
  return expanded.get(id);
}

export function expandedEntries(): Array<[string, ExpandedEntry]> {
  return [...expanded];
}

export function expandedCount(): number {
  return expanded.size;
}
