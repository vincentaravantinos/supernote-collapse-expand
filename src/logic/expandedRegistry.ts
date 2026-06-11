import { Rect } from 'sn-plugin-lib';

export interface ExpandedEntry {
  iconRect: Rect; // last-known icon position, updated after each redraw
  contentBBox: Rect; // absolute content bbox at last (re)expand
}

// Sections expanded in THIS session. The motion handler (iconMoveRedraw) reads
// this to gate on "did a drag grab an expanded section's icon?" and to redraw on
// release. In-memory only: after an app restart it's empty and live redraw stays
// dormant until the section is expanded again. Kept in its own module so both
// expandAction (registers) and iconMoveRedraw (reads + triggers expandOne) can
// use it without an import cycle.
const expanded = new Map<string, ExpandedEntry>();

export function noteSectionExpanded(id: string, iconRect: Rect, contentBBox: Rect): void {
  expanded.set(id, { iconRect, contentBBox });
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
