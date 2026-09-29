import { ICON_HIT_PAD, LOG } from '../constants';
import { padded, rectContains } from '../utils/geometryHelpers';
import { runExclusive } from './operation';
import { isLandscape } from '../utils/orientation';
import { expandSections } from './expandAction';
import { recollapseSections } from './recollapseAction';
import { buildIconCache, getCachedIcons, PageIconEntry } from './iconPageCache';
import { ensureAllPermissions } from '../utils/permissions';
import { isTapDistance, noteGestureDown } from './tapGesture';
import { getCurrentFilePathOrNull, getCurrentPageNumOrNull } from '../utils/currentFile';

// SPEC.md REQ-090/100/110: requested once, on the first qualifying tap of
// any kind (hit or miss — we can't tell in advance), silently on denial,
// and never repeated via another tap in this activation even if declined
// (unlike a button-triggered operation's own gate, which re-asks every
// time — see ensureAllPermissions' own grant-only cache). This flag is what
// enforces "never repeated", since ensureAllPermissions itself doesn't cache
// denials.
let permissionsAttempted = false;

async function ensureTapPermissions(): Promise<void> {
  if (permissionsAttempted) return;
  permissionsAttempted = true;
  await ensureAllPermissions(
    'Collapse/Expand needs permission to read and change the page.',
    { silent: true },
  );
}

// A single finger tap directly on a + icon toggles that section
// (collapsed -> expand, expanded -> recollapse). Pen taps are ignored — they
// draw ink, so reacting to them would fight the user's drawing.
let downQualifies = false;

function isQualifying(toolType: number | undefined, pointerCount: number | undefined): boolean {
  return toolType === 1 && pointerCount === 1;
}

// ACTION_DOWN: in-memory only, record the start point for the tap test on UP.
export function onTapDown(x: number, y: number, toolType: number | undefined, pointerCount: number | undefined): void {
  noteGestureDown(x, y);
  downQualifies = isQualifying(toolType, pointerCount);
}

// ACTION_UP: if this was a single-finger tap (not a drag, not a pen stroke),
// look for a + icon under the point and toggle it.
export function onTapUp(x: number, y: number, toolType: number | undefined, pointerCount: number | undefined): void {
  const qualifies = downQualifies && isQualifying(toolType, pointerCount);
  downQualifies = false;
  if (!qualifies) return;
  if (!isTapDistance(x, y)) return; // drag, not a tap
  void handleTap(x, y);
}

function findHit(icons: PageIconEntry[], x: number, y: number): PageIconEntry | undefined {
  return icons.find((icon) =>
    rectContains(padded(icon.rect, ICON_HIT_PAD), x, y) ||
    (icon.nameRect && rectContains(padded(icon.nameRect, ICON_HIT_PAD), x, y)),
  );
}

async function handleTap(x: number, y: number): Promise<void> {
  if (await isLandscape()) return;
  // Deliberately before any note-context check: asking right away, even on
  // a tap that turns out to be outside a note (e.g. dismissing the
  // plugin-install dialog), reads as natural — "right after installing" —
  // rather than surprising later once the user is mid-note.
  await ensureTapPermissions();
  const page = await getCurrentPageNumOrNull();
  if (page === null) return;

  let icons = getCachedIcons(page);
  if (!icons) {
    const filePath = await getCurrentFilePathOrNull();
    if (filePath === null) return;
    icons = await buildIconCache(filePath, page);
  }

  let hit = findHit(icons, x, y);
  if (!hit) {
    // The cache can go stale if the icon was moved by a plain native drag
    // (no plugin operation involved, so nothing told us to rebuild). One
    // fresh rebuild + retry before concluding this genuinely isn't a tap on
    // an icon.
    const filePath = await getCurrentFilePathOrNull();
    if (filePath === null) return;
    icons = await buildIconCache(filePath, page);
    hit = findHit(icons, x, y);
    if (hit) console.error(`${LOG} stale-cache retry recovered a hit x=${x} y=${y}`);
  }
  if (!hit) return;

  // If another op (button press or live redraw) is in flight, runExclusive
  // drops this tap silently rather than alerting, since the user didn't
  // press a button.
  const target = hit;
  await runExclusive('tap-toggle', async (op) => {
    await op.showView();
    const filePath = await getCurrentFilePathOrNull();
    if (filePath === null) return;
    op.touched(filePath, page);
    if (target.section.isExpanded) {
      await recollapseSections([target.id], filePath, page);
    } else {
      await expandSections([{ section: target.section, icon: target.iconEl }], filePath, page);
    }
  });
}
