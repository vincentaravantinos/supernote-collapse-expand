import { PluginFileAPI } from 'sn-plugin-lib';
import {
  CE_FRAME_PREFIX,
  CE_MASK_PREFIX,
  CE_NAME_PREFIX,
  CE_PART_PREFIX,
  CE_PLUG_PREFIX,
  CE_UNDERLINE_PREFIX,
  LOG,
} from '../constants';
import { CollapseSection } from '../model/types';

export type UserDataKind =
  | { kind: 'section'; section: CollapseSection }
  | { kind: 'part'; id: string }
  | { kind: 'mask'; id: string }
  | { kind: 'frame'; id: string }
  | { kind: 'name'; id: string }
  | { kind: 'underline'; id: string }
  | null;

// The icon's CURRENT rect (textBox.textRect) from an already-fetched element
// list. A getLassoElements element reports a stale rect after a move, so prefer
// the getElements match by section id, then the lassoed element, then the saved
// rect.
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

// As iconRectFromElements, but fetches the list itself. Callers must have
// flushed pending edits (saveCurrentNote) first so getElements sees a moved icon.
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

// Fetch a single element by num and confirm it's the section icon we expect.
// Lets a caller avoid a full-page getElements when it already knows the icon's
// num. Returns null if the num is missing/stale or the userData id doesn't match
// (caller then falls back to a full scan).
export async function getIconByNum(
  filePath: string,
  page: number,
  num: number | undefined,
  sectionId: string,
): Promise<any | null> {
  if (typeof num !== 'number') return null;
  const res: any = await PluginFileAPI.getElement(filePath, page, num);
  const el = res?.success ? res.result : null;
  if (!el) return null;
  const ud = readUserData(el);
  return ud?.kind === 'section' && ud.section?.id === sectionId ? el : null;
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

  if (udata.startsWith(CE_NAME_PREFIX)) {
    return { kind: 'name', id: udata.substring(CE_NAME_PREFIX.length) };
  }

  if (udata.startsWith(CE_UNDERLINE_PREFIX)) {
    return { kind: 'underline', id: udata.substring(CE_UNDERLINE_PREFIX.length) };
  }

  return null;
}

// Map every section id -> its icon element, fresh from getElements (not a
// lassoed snapshot). Used to resolve icons for a recollapse triggered by
// lassoing section content rather than the icon itself.
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

async function resolveFreshIcon(
  filePath: string,
  page: number,
  sectionId: string,
): Promise<any | null> {
  return (await findSectionIcons(filePath, page)).get(sectionId) ?? null;
}

// SDK error 102 ("This app is not allowed to use this API") means the note
// wasn't in a stable/focused state when the call landed — e.g. the user's
// tap simultaneously switched the foreground app away from Notes. The user
// has no expectation of the operation succeeding in that case, so callers
// use this to fail silently (log-only) instead of alerting.
export function isUnstableNoteError(res: any): boolean {
  return res?.error?.code === 102;
}

export async function writeSection(
  filePath: string,
  page: number,
  iconElement: any,
  section: CollapseSection,
  freshIcon?: any,
): Promise<{ ok: boolean; unstableNote: boolean }> {
  try {
    // modifyElements must target the icon by its CURRENT num. A lassoed snapshot
    // goes stale after a move, so we resolve the icon fresh from getElements —
    // UNLESS the caller already holds one (expand/recollapse pass theirs from the
    // getElements they just did; nums are stable across insert/delete). Skipping
    // the re-fetch avoids a second full-page read (the dominant cost on big pages).
    const target = freshIcon ?? (await resolveFreshIcon(filePath, page, section.id)) ?? iconElement;
    target.userData = CE_PLUG_PREFIX + JSON.stringify(section);
    target.pageNum = page;
    const res: any = await PluginFileAPI.modifyElements(filePath, page, [target]);
    if (!res?.success) {
      console.error(`${LOG} modifyElements res=${JSON.stringify(res)}`);
    }
    return { ok: !!res?.success, unstableNote: isUnstableNoteError(res) };
  } catch (e) {
    console.error(`${LOG} Failed to write userData:`, e);
    return { ok: false, unstableNote: false };
  }
}
