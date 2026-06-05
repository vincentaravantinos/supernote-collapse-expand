import { PluginCommAPI, PluginFileAPI, PluginManager, PluginNoteAPI, Rect } from 'sn-plugin-lib';
import {
  CE_PLUG_PREFIX,
  DEFAULT_ICON_FILENAME,
  ELEMENT_TYPES,
  ICON_SIZE,
  LOG,
} from '../constants';
import { CollapseSection } from '../model/types';
import { readUserData } from './userDataManager';

// =====================================================================
// WORKAROUND — SDK bug: `saveCurrentNote` rescales a *moved* picture
// element to ~14×14 when it commits the move, and `modifyElements` cannot
// reset a picture's `rect`. The only API that honours a picture's rect is
// `insertElements`, so we restore the icon's size by deleting and
// re-inserting it. See FEEDBACK.md: "saveCurrentNote rescales a moved
// picture element to ~14×14 on commit".
//
// This file is intentionally self-contained (it resolves its own icon
// path and builds its own element) so that when the SDK is fixed the
// removal is trivial: delete this file and the two
// `restampIconIfShrunk(...)` calls (+ imports) in expandAction.ts and
// recollapseAction.ts. Nothing else depends on it.
// =====================================================================

// Re-create the section's `+` icon at ICON_SIZE if the SDK has shrunk it.
// No-op when the icon is already the right size (the common no-move case),
// so an element id only churns when the user actually moved the icon.
export async function restampIconIfShrunk(
  filePath: string,
  page: number,
  section: CollapseSection,
): Promise<void> {
  // Find the on-page icon for this section and read its current rect.
  const allRes: any = await PluginFileAPI.getElements(page, filePath);
  const all: any[] = allRes?.success && Array.isArray(allRes.result) ? allRes.result : [];
  let icon: any = null;
  for (const el of all) {
    const ud = readUserData(el);
    if (ud?.kind === 'section' && ud.section?.id === section.id) { icon = el; break; }
  }
  const rect = icon?.picture?.rect;
  if (!icon || !rect || typeof icon.numInPage !== 'number') return;

  const width = rect.right - rect.left;
  if (width === ICON_SIZE) return; // not shrunk — nothing to do.

  // Re-create at ICON_SIZE, anchored at the (correct) current top-left,
  // carrying the section userData with a corrected iconRect.
  const fixedRect: Rect = {
    left: rect.left,
    top: rect.top,
    right: rect.left + ICON_SIZE,
    bottom: rect.top + ICON_SIZE,
  };
  const fixedSection: CollapseSection = { ...section, iconRect: fixedRect };

  const dirRes: any = await PluginManager.getPluginDirPath();
  const pluginDir: string | null =
    typeof dirRes === 'string' ? dirRes : (dirRes?.result ?? null);
  if (typeof pluginDir !== 'string' || pluginDir.length === 0) {
    console.error(`${LOG} restampIconIfShrunk: getPluginDirPath returned ${JSON.stringify(dirRes)}`);
    return;
  }
  const picturePath = `${pluginDir.replace(/\/+$/, '')}/${DEFAULT_ICON_FILENAME}`;

  const createRes: any = await PluginCommAPI.createElement(ELEMENT_TYPES.PICTURE);
  if (!createRes?.success || !createRes.result) {
    console.error(`${LOG} restampIconIfShrunk: createElement failed res=${JSON.stringify(createRes)}`);
    return;
  }
  const newIcon: any = createRes.result;
  newIcon.picture = { picturePath, rect: fixedRect };
  newIcon.userData = CE_PLUG_PREFIX + JSON.stringify(fixedSection);
  newIcon.pageNum = page;

  const delRes: any = await PluginFileAPI.deleteElements(filePath, page, [icon.numInPage]);
  if (!delRes?.success) {
    console.error(`${LOG} restampIconIfShrunk: deleteElements failed res=${JSON.stringify(delRes)}`);
  }
  const insRes: any = await PluginFileAPI.insertElements(filePath, page, [newIcon]);
  if (!insRes?.success) {
    console.error(`${LOG} restampIconIfShrunk: insertElements failed res=${JSON.stringify(insRes)}`);
  }
  try { newIcon.recycle?.(); } catch { /* ignore */ }
  await PluginNoteAPI.saveCurrentNote();
  console.log(`${LOG} restampIconIfShrunk: re-created icon at ${ICON_SIZE}x${ICON_SIZE} (was ${width}px wide)`);
}
