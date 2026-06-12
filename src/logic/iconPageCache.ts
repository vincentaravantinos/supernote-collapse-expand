import { PluginFileAPI, Rect } from 'sn-plugin-lib';
import { readUserData } from '../utils/userDataManager';
import { CollapseSection } from '../model/types';

// Every CE_PLUG icon (collapsed or expanded) on one page, for cheap tap
// hit-testing (see iconTapToggle). `iconEl` is the raw element, ready to pass
// as the `icon` of an expandSections target.
export interface PageIconEntry {
  id: string;
  section: CollapseSection;
  iconEl: any;
  rect: Rect;
}

// No page-change event exists, so this cache is keyed by page number and
// rebuilt whenever a tap arrives for a different page (or after our own
// mutations invalidate it via invalidateIconCache).
let cachedPage: number | null = null;
let cachedIcons: PageIconEntry[] = [];

export function getCachedIcons(page: number): PageIconEntry[] | null {
  return cachedPage === page ? cachedIcons : null;
}

export function invalidateIconCache(): void {
  cachedPage = null;
  cachedIcons = [];
}

export async function buildIconCache(filePath: string, page: number): Promise<PageIconEntry[]> {
  const allRes: any = await PluginFileAPI.getElements(page, filePath);
  const all: any[] = allRes?.success && Array.isArray(allRes.result) ? allRes.result : [];

  const icons: PageIconEntry[] = [];
  for (const el of all) {
    const ud = readUserData(el);
    if (ud?.kind === 'section' && ud.section?.id && el?.textBox?.textRect) {
      icons.push({ id: ud.section.id, section: ud.section, iconEl: el, rect: el.textBox.textRect });
    }
  }

  cachedPage = page;
  cachedIcons = icons;
  return icons;
}
