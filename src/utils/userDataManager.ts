import { PluginFileAPI } from 'sn-plugin-lib';
import {
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

  return null;
}

export async function writeSection(
  filePath: string,
  page: number,
  iconElement: any,
  section: CollapseSection,
): Promise<boolean> {
  try {
    iconElement.userData = CE_PLUG_PREFIX + JSON.stringify(section);
    iconElement.pageNum = page;
    const res: any = await PluginFileAPI.modifyElements(filePath, page, [iconElement]);
    if (!res?.success) {
      console.error(`${LOG} modifyElements res=${JSON.stringify(res)}`);
    }
    return !!res?.success;
  } catch (e) {
    console.error(`${LOG} Failed to write userData:`, e);
    return false;
  }
}
