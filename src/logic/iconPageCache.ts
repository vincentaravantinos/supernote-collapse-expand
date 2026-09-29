import { Rect } from 'sn-plugin-lib';
import { LOG } from '../constants';
import { deleteElementsVerified, getPageElements, readUserData, writeSection } from '../utils/userDataManager';
import { elementsBBox, getPageSize } from '../utils/elementSerializer';
import { findNameElements, findUnderlineElements } from './nameAction';
import { generateSectionId } from './collapseAction';
import { acquireBusy, releaseBusy } from './busy';
import { CollapseSection } from '../model/types';

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

// Runs a page repair under the busy guard: directly if the caller already
// holds it (runExclusive's post-operation rebuild), otherwise only if it's
// free — skipped silently, and tried again next call, if an operation is in
// flight.
async function underGuard(locked: boolean, repair: () => Promise<void>): Promise<void> {
  if (locked) return repair();
  if (!acquireBusy()) return;
  try {
    await repair();
  } finally {
    releaseBusy();
  }
}

export async function buildIconCache(
  filePath: string,
  page: number,
  opts: { locked?: boolean } = {},
): Promise<PageIconEntry[]> {
  const locked = opts.locked ?? false;
  const all = await getPageElements(filePath, page);

  const icons: PageIconEntry[] = [];
  for (const el of all) {
    const ud = readUserData(el);
    if (ud?.kind === 'plug' && ud.section?.id && el?.textBox?.textRect) {
      icons.push({ id: ud.section.id, section: ud.section, iconEl: el, rect: el.textBox.textRect });
    }
  }

  // REQ-400: self-heal a duplicated section id (e.g. a native
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
  // data loss, just not picked up as that icon's name anymore.) Runs under
  // the busy guard (see underGuard), never concurrently with an operation.
  const seenIds = new Set<string>();
  for (const icon of icons) {
    if (!seenIds.has(icon.id)) {
      seenIds.add(icon.id);
      continue;
    }
    if (icon.section.isExpanded) continue;
    await underGuard(locked, async () => {
      const healedSection: CollapseSection = { ...icon.section, id: generateSectionId() };
      const { ok } = await writeSection(filePath, page, icon.iconEl, healedSection, icon.iconEl);
      if (ok) {
        icon.id = healedSection.id;
        icon.section = healedSection;
      } else {
        console.error(`${LOG} self-heal: failed to write regenerated id for a duplicated section`);
      }
    });
  }

  // REQ-660: an underline whose name was erased entirely has nothing left to
  // be redrawn with — remove it.
  const orphanNums: number[] = [];
  const underlineIds = new Set<string>();
  for (const el of all) {
    const ud = readUserData(el);
    if (ud?.kind === 'underline') underlineIds.add(ud.id);
  }
  for (const id of underlineIds) {
    if (findNameElements(all, id).length > 0) continue;
    for (const el of findUnderlineElements(all, id)) {
      if (typeof el.numInPage === 'number') orphanNums.push(el.numInPage);
    }
  }
  if (orphanNums.length > 0) {
    await underGuard(locked, async () => {
      const { ok, remaining } = await deleteElementsVerified(filePath, page, orphanNums);
      if (!ok) console.error(`${LOG} orphaned underline cleanup: ${remaining.length} element(s) never removed`);
    });
  }

  if (icons.length > 0) {
    const pageSize = await getPageSize(filePath, page);
    for (const icon of icons) {
      const nameEls = findNameElements(all, icon.id);
      if (nameEls.length === 0) continue;
      const bbox = await elementsBBox(nameEls, pageSize);
      if (bbox) icon.nameRect = bbox;
    }
  }

  cachedPage = page;
  cachedIcons = icons;
  return icons;
}
