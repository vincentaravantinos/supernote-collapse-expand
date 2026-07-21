import { PluginFileAPI, Rect } from 'sn-plugin-lib';
import { LOG } from '../constants';
import { readUserData } from '../utils/userDataManager';
import { contentBoundingBox, getPageSize, serializeElement } from '../utils/elementSerializer';
import { findNameElements } from './nameAction';
import { CollapsedElement, CollapseSection } from '../model/types';

// Every CE_PLUG icon (collapsed or expanded) on one page, for cheap tap
// hit-testing (see iconTapToggle). `iconEl` is the raw element, ready to pass
// as the `icon` of an expandSections target. `nameRect` (if the section has a
// name) lets a tap on the name also count, same as tapping the icon.
export interface PageIconEntry {
  id: string;
  section: CollapseSection;
  iconEl: any;
  rect: Rect;
  nameRect?: Rect;
}

// No page-change event exists, so this cache is keyed by page number and
// rebuilt whenever a tap arrives for a different page, or eagerly right
// after our own mutations (see buildIconCache's call sites) so the cost is
// paid while a working bubble is already up, not silently on the next tap.
let cachedPage: number | null = null;
let cachedIcons: PageIconEntry[] = [];

export function getCachedIcons(page: number): PageIconEntry[] | null {
  return cachedPage === page ? cachedIcons : null;
}

export async function buildIconCache(filePath: string, page: number): Promise<PageIconEntry[]> {
  const allRes: any = await PluginFileAPI.getElements(page, filePath);
  const all: any[] = allRes?.success && Array.isArray(allRes.result) ? allRes.result : [];

  const icons: PageIconEntry[] = [];
  for (const el of all) {
    const ud = readUserData(el);
    if (ud?.kind === 'plug' && ud.section?.id && el?.textBox?.textRect) {
      icons.push({ id: ud.section.id, section: ud.section, iconEl: el, rect: el.textBox.textRect });
    }
  }

  if (icons.length > 0) {
    const pageSize = await getPageSize(filePath, page);
    for (const icon of icons) {
      const nameEls = findNameElements(all, icon.id);
      if (nameEls.length === 0) continue;
      const serialized: CollapsedElement[] = [];
      for (const el of nameEls) {
        const data = await serializeElement(el);
        if (data) serialized.push({ numInPage: el.numInPage, data });
      }
      const bbox = contentBoundingBox(serialized, pageSize);
      if (bbox) icon.nameRect = bbox;
    }
  }

  cachedPage = page;
  cachedIcons = icons;
  return icons;
}
