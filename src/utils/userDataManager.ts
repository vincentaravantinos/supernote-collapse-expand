import { PluginFileAPI } from 'sn-plugin-lib';
import {
  CE_FRAME_PREFIX,
  CE_MASK_PREFIX,
  CE_PART_PREFIX,
  CE_PLUG_PREFIX,
  LOG,
} from '../constants';
import { CollapseSection } from '../model/types';

export type UserDataKind =
  | { kind: 'section'; section: CollapseSection }
  | { kind: 'part'; id: string }
  | { kind: 'mask'; id: string }
  | { kind: 'frame'; id: string }
  | null;

// Resolve the icon's CURRENT on-page rect, given an already-fetched element
// list. The icon is a TEXT element, so its rect is textBox.textRect. The
// element from getLassoElements can report a stale rect after a move, while
// the persisted getElements list reflects it; prefer the getElements match
// (by section id), then fall back to the lassoed element, then the
// last-known saved rect.
export function iconRectFromElements(
  all: any[],
  section: CollapseSection,
  iconElement: any,
): any {
  for (const el of all) {
    const ud = readUserData(el);
    if (ud?.kind === 'section' && ud.section?.id === section.id && el?.textBox?.textRect) {
      return el.textBox.textRect;
    }
  }
  return iconElement?.textBox?.textRect ?? section.iconRect;
}

// Convenience wrapper that fetches the element list itself. Callers must
// have flushed pending edits (saveCurrentNote) first so getElements sees the
// moved icon.
export async function getCurrentIconRect(
  filePath: string,
  page: number,
  section: CollapseSection,
  iconElement: any,
): Promise<any> {
  const allRes: any = await PluginFileAPI.getElements(page, filePath);
  const all: any[] = allRes?.success && Array.isArray(allRes.result) ? allRes.result : [];
  return iconRectFromElements(all, section, iconElement);
}

export function readUserData(element: any): UserDataKind {
  const udata = element?.userData;
  if (typeof udata !== 'string') return null;

  if (udata.startsWith(CE_PLUG_PREFIX)) {
    try {
      const section = JSON.parse(udata.substring(CE_PLUG_PREFIX.length));
      return { kind: 'section', section: section as CollapseSection };
    } catch (e) {
      console.error(`${LOG} Failed to parse CE_PLUG userData:`, e);
      return null;
    }
  }

  if (udata.startsWith(CE_PART_PREFIX)) {
    return { kind: 'part', id: udata.substring(CE_PART_PREFIX.length) };
  }

  if (udata.startsWith(CE_MASK_PREFIX)) {
    return { kind: 'mask', id: udata.substring(CE_MASK_PREFIX.length) };
  }

  if (udata.startsWith(CE_FRAME_PREFIX)) {
    return { kind: 'frame', id: udata.substring(CE_FRAME_PREFIX.length) };
  }

  return null;
}

// Map every section's id -> its icon element, resolved FRESH from getElements
// (one read), rather than trusting lassoed snapshots. Used to find the icon(s)
// for a recollapse triggered by lassoing section content rather than the icon.
export async function findSectionIcons(
  filePath: string,
  page: number,
): Promise<Map<string, any>> {
  const allRes: any = await PluginFileAPI.getElements(page, filePath);
  const all: any[] = allRes?.success && Array.isArray(allRes.result) ? allRes.result : [];
  const byId = new Map<string, any>();
  for (const el of all) {
    const ud = readUserData(el);
    if (ud?.kind === 'section' && ud.section?.id) byId.set(ud.section.id, el);
  }
  return byId;
}

// Resolve a single section's icon element FRESH from getElements (by section
// id), rather than trusting a lassoed snapshot. Returns null if not found.
async function resolveFreshIcon(
  filePath: string,
  page: number,
  sectionId: string,
): Promise<any | null> {
  return (await findSectionIcons(filePath, page)).get(sectionId) ?? null;
}

export async function writeSection(
  filePath: string,
  page: number,
  iconElement: any,
  section: CollapseSection,
): Promise<boolean> {
  try {
    // Target the FRESH icon from getElements, not the passed (lassoed) element.
    // After the user moves the icon, the lassoed snapshot's identity
    // (numInPage) is stale, so modifyElements on it misses the real icon and
    // the userData update (e.g. isExpanded=true on expand) never persists —
    // which made a subsequent recollapse get misread as an expand and
    // double-insert. This is the write-side twin of the stale picture.rect bug
    // (already worked around for reads via iconRectFromElements/getCurrentIconRect).
    // Fall back to the lassoed element only if the fresh lookup fails.
    const target = (await resolveFreshIcon(filePath, page, section.id)) ?? iconElement;
    target.userData = CE_PLUG_PREFIX + JSON.stringify(section);
    target.pageNum = page;
    const res: any = await PluginFileAPI.modifyElements(filePath, page, [target]);
    if (!res?.success) {
      console.error(`${LOG} modifyElements res=${JSON.stringify(res)}`);
    }
    return !!res?.success;
  } catch (e) {
    console.error(`${LOG} Failed to write userData:`, e);
    return false;
  }
}
