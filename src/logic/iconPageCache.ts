import { Rect } from 'sn-plugin-lib';
import { LOG } from '../constants';
import { deleteElementsVerified, getPageElements, readUserData, writeSection } from '../utils/userDataManager';
import { elementsBBox, getPageSize } from '../utils/elementSerializer';
import { findNameElements, findUnderlineElements } from './nameAction';
import { generateSectionId } from './collapseAction';
import { CollapseSection } from '../model/types';
import { diag, safeJson } from '../utils/diagLog';

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

// `repair`: also fix the page (duplicate ids, orphaned underlines). Only
// runExclusive's post-operation rebuild passes it — it holds the busy guard,
// and the change then always follows something the user just did, never a
// silent write at startup or on a plain tap-cache lookup.
export async function buildIconCache(
  filePath: string,
  page: number,
  opts: { repair?: boolean } = {},
): Promise<PageIconEntry[]> {
  const repair = opts.repair ?? false;
  const all = await getPageElements(filePath, page);

  const icons: PageIconEntry[] = [];
  let plugCount = 0;
  for (const el of all) {
    const ud = readUserData(el);
    if (ud?.kind === 'plug' && ud.section?.id) {
      plugCount++;
      // [B-032] TEMP: fall back to the saved icon rect if the firmware doesn't
      // return the text box's rect.
      const rect = el?.textBox?.textRect ?? ud.section.iconRect;
      if (!el?.textBox?.textRect) diag(`scan: icon without textRect type=${el?.type} textBox=${safeJson(el?.textBox, 160)} → using saved rect`);
      if (rect) icons.push({ id: ud.section.id, section: ud.section, iconEl: el, rect });
    }
  }
  const textEls = all.filter((el: any) => el?.type === 500);
  diag(`scan: page=${page} elements=${all.length} text=${textEls.length} icons=${plugCount}${icons[0] ? ` first rect=${safeJson(icons[0].rect)} saved=${safeJson(icons[0].section.iconRect)}` : ''}`);
  if (plugCount === 0 && textEls.length > 0) {
    const t = textEls[0];
    diag(`scan: first text el userData=${typeof t?.userData === 'string' ? `${t.userData.length} chars "${t.userData.slice(0, 12)}"` : safeJson(t?.userData)} textBox=${safeJson(t?.textBox, 160)}`);
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
  // data loss, just not picked up as that icon's name anymore.)
  const seenIds = new Set<string>();
  for (const icon of icons) {
    if (!seenIds.has(icon.id)) {
      seenIds.add(icon.id);
      continue;
    }
    if (!repair || icon.section.isExpanded) continue;
    const healedSection: CollapseSection = { ...icon.section, id: generateSectionId() };
    const { ok } = await writeSection(filePath, page, icon.iconEl, healedSection, icon.iconEl);
    if (ok) {
      icon.id = healedSection.id;
      icon.section = healedSection;
    } else {
      console.error(`${LOG} self-heal: failed to write regenerated id for a duplicated section`);
    }
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
  if (repair && orphanNums.length > 0) {
    const { ok, remaining } = await deleteElementsVerified(filePath, page, orphanNums);
    if (!ok) console.error(`${LOG} orphaned underline cleanup: ${remaining.length} element(s) never removed`);
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
