import { PluginCommAPI, PluginManager } from 'sn-plugin-lib';
import { ICON_HIT_PAD, LOG, TAP_MAX_PX, dlog } from '../constants';
import { padded, rectContains } from '../utils/geometryHelpers';
import { acquireBusy, releaseBusy } from './busy';
import { isLandscape } from '../utils/orientation';
import { expandSections } from './expandAction';
import { recollapseSections } from './recollapseAction';
import { buildIconCache, getCachedIcons, invalidateIconCache } from './iconPageCache';

// BACKLOG #8: a single finger tap directly on a + icon toggles that section
// (collapsed -> expand, expanded -> recollapse). Pen taps are ignored — they
// draw ink, so reacting to them would fight the user's drawing.
let downX = 0;
let downY = 0;
let downQualifies = false;

function isQualifying(toolType: number | undefined, pointerCount: number | undefined): boolean {
  return toolType === 1 && pointerCount === 1;
}

// ACTION_DOWN: in-memory only, record the start point for the tap test on UP.
export function onTapDown(x: number, y: number, toolType: number | undefined, pointerCount: number | undefined): void {
  downX = x;
  downY = y;
  downQualifies = isQualifying(toolType, pointerCount);
}

// ACTION_UP: if this was a single-finger tap (not a drag, not a pen stroke),
// look for a + icon under the point and toggle it.
export function onTapUp(x: number, y: number, toolType: number | undefined, pointerCount: number | undefined): void {
  const qualifies = downQualifies && isQualifying(toolType, pointerCount);
  downQualifies = false;
  if (!qualifies) return;
  if (Math.abs(x - downX) >= TAP_MAX_PX || Math.abs(y - downY) >= TAP_MAX_PX) return; // drag, not a tap
  void handleTap(x, y);
}

async function handleTap(x: number, y: number): Promise<void> {
  if (await isLandscape()) return;
  const pgRes: any = await PluginCommAPI.getCurrentPageNum();
  if (!pgRes?.success || typeof pgRes.result !== 'number') return;
  const page = pgRes.result as number;

  let icons = getCachedIcons(page);
  if (!icons) {
    const fpRes: any = await PluginCommAPI.getCurrentFilePath();
    if (!fpRes?.success || typeof fpRes.result !== 'string') return;
    icons = await buildIconCache(fpRes.result as string, page);
  }

  const hit = icons.find((icon) => rectContains(padded(icon.rect, ICON_HIT_PAD), x, y));
  if (!hit) return;

  // Another op (button press or live redraw) is in flight — drop this tap
  // silently rather than alerting, since the user didn't press a button.
  if (!acquireBusy()) return;

  let viewShown = false;
  try {
    const fpRes: any = await PluginCommAPI.getCurrentFilePath();
    if (!fpRes?.success || typeof fpRes.result !== 'string') return;
    const filePath = fpRes.result as string;

    try {
      await PluginManager.showPluginView();
      viewShown = true;
    } catch (e) {
      dlog(`${LOG} tap-toggle showPluginView failed: ${e}`);
    }

    if (hit.section.isExpanded) {
      await recollapseSections([hit.id], filePath, page);
    } else {
      await expandSections([{ section: hit.section, icon: hit.iconEl }], filePath, page);
    }
    invalidateIconCache();
  } catch (e) {
    console.error(`${LOG} tap-toggle failed: ${e}`);
  } finally {
    if (viewShown) {
      try { await PluginManager.closePluginView(); } catch (e) { dlog(`${LOG} tap-toggle closePluginView failed: ${e}`); }
    }
    releaseBusy();
  }
}
