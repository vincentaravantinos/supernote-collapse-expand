import { PluginFileAPI, Rect } from 'sn-plugin-lib';
import { LOG } from '../constants';
import { readUserData, writeSection } from '../utils/userDataManager';
import { contentBoundingBox, getPageSize, serializeElement } from '../utils/elementSerializer';
import { findNameElements } from './nameAction';
import { generateSectionId } from './collapseAction';
import { acquireBusy, releaseBusy } from './busy';
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

  // CR-010/REQ-400: self-heal a duplicated section id (e.g. a native
  // copy-paste of a collapsed icon) — opportunistic, since this function
  // already scans every icon on the page for other reasons. Only safe for a
  // COLLAPSED colliding icon: an expanded collision also has CE_PART/MASK/
  // FRAME/HANDLE elements tagged with the same id that a bare icon-id change
  // would orphan instead of fix — left untouched. A collapsed section's own
  // content lives entirely in the icon's userData, so regenerating just the
  // icon's id is safe for that; a CE_NAME/CE_UNDERLINE (if any) stays tagged
  // with the OLD id, which after healing belongs solely to whichever icon
  // kept it (the first one found below) — the natural outcome, since a name
  // is a separate, position-fixed element a plain icon copy-paste wouldn't
  // have duplicated in the first place. (Narrow, accepted exception: a
  // deliberate copy-paste of the icon *together with* its name would leave
  // the pasted name cosmetically orphaned from the healed duplicate — no
  // data loss, just not picked up as that icon's name anymore.) Guarded by
  // the same busy lock every other mutation uses, so this never runs
  // concurrently with an in-flight operation — skipped (silently, tried
  // again next call) if one already holds it.
  const seenIds = new Set<string>();
  for (const icon of icons) {
    if (!seenIds.has(icon.id)) {
      seenIds.add(icon.id);
      continue;
    }
    if (icon.section.isExpanded) continue;
    if (!acquireBusy()) continue;
    try {
      const healedSection: CollapseSection = { ...icon.section, id: generateSectionId() };
      const { ok } = await writeSection(filePath, page, icon.iconEl, healedSection, icon.iconEl);
      if (ok) {
        icon.id = healedSection.id;
        icon.section = healedSection;
      } else {
        console.error(`${LOG} self-heal: failed to write regenerated id for a duplicated section`);
      }
    } finally {
      releaseBusy();
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
