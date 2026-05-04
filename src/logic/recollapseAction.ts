import { PluginCommAPI, PluginFileAPI, PluginNoteAPI, PointUtils, Rect } from 'sn-plugin-lib';
import {
  LOG,
  MAX_USERDATA_BYTES,
  CE_PLUG_PREFIX,
} from '../constants';
import { dumpElements } from '../utils/diagnostics';
import { buildElement, serializeElement } from '../utils/elementSerializer';
import { readUserData, writeSection } from '../utils/userDataManager';
import { CollapseSection, CollapsedElement } from '../model/types';

function rectFromPoints(points: { x: number; y: number }[]): Rect {
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

export async function recollapseAction(
  section: CollapseSection,
  iconElement: any,
  filePath: string,
  page: number,
) {
  const iconRectNow = iconElement?.textBox?.textRect ?? section.iconRect;

  // Flush any in-memory edits to the file so getElements below sees strokes
  // the user drew while the section was expanded.
  await PluginNoteAPI.saveCurrentNote();

  await dumpElements('DIAG recollapse entry', filePath, page);

  // 1. Find every element belonging to this section via userData id.
  const allRes: any = await PluginFileAPI.getElements(page, filePath);
  const all: any[] = allRes?.success && Array.isArray(allRes.result) ? allRes.result : [];

  let borderEl: any = null;
  const partEls: any[] = [];
  for (const el of all) {
    const ud = readUserData(el);
    if (!ud) continue;
    if (ud.kind === 'border' && ud.id === section.id) borderEl = el;
    else if (ud.kind === 'part' && ud.id === section.id) partEls.push(el);
  }

  if (!borderEl) {
    console.error(`${LOG} recollapse: border for section ${section.id} not found`);
  }

  // 2. Lasso the border's rect to pick up untagged user-added strokes drawn
  //    on top while the section was expanded.
  const newCollapsed: CollapsedElement[] = [];
  const numSet = new Set<number>();

  for (const el of partEls) {
    if (typeof el.numInPage === 'number') numSet.add(el.numInPage);
    const data = await serializeElement(el);
    if (data) newCollapsed.push({ numInPage: el.numInPage, data });
  }

  if (borderEl?.geometry?.points?.length) {
    const lassoRect = rectFromPoints(borderEl.geometry.points);
    await PluginCommAPI.lassoElements(lassoRect);
    const lassoRes: any = await PluginCommAPI.getLassoElements();
    const lassoed: any[] = lassoRes?.success ? (lassoRes.result ?? []) : [];
    for (const el of lassoed) {
      if (readUserData(el) !== null) continue; // skip icon, border, already-tagged parts
      if (typeof el.numInPage === 'number') numSet.add(el.numInPage);
      const data = await serializeElement(el);
      if (data) newCollapsed.push({ numInPage: el.numInPage, data });
    }
    for (const el of lassoed) { try { el.recycle?.(); } catch { /* ignore */ } }
  }

  if (typeof borderEl?.numInPage === 'number') numSet.add(borderEl.numInPage);

  // 3. Update section state. hiddenElements get put back on the page below,
  //    so the persisted section should not retain a stale copy.
  const hiddenToRestore = section.hiddenElements ?? [];
  const updatedSection: CollapseSection = {
    ...section,
    collapsedElements: newCollapsed,
    isExpanded: false,
    iconRect: iconRectNow,
  };
  delete updatedSection.hiddenElements;

  const payload = CE_PLUG_PREFIX + JSON.stringify(updatedSection);
  if (payload.length > MAX_USERDATA_BYTES) {
    alert('Content too large to re-collapse. Remove some content from this section.');
    return;
  }

  // 4. Delete tagged + new content + border, commit.
  const numsToDelete = Array.from(numSet);
  if (numsToDelete.length > 0) {
    const delRes: any = await PluginFileAPI.deleteElements(filePath, page, numsToDelete);
    if (!delRes?.success) {
      console.error(`${LOG} deleteElements failed res=${JSON.stringify(delRes)}`);
    }
    await PluginNoteAPI.saveCurrentNote();
  }

  // 5. Restore previously-hidden content at its original absolute coordinates.
  if (hiddenToRestore.length > 0) {
    const sizeRes: any = await PluginFileAPI.getPageSize(filePath, page);
    const pageSize = sizeRes?.success && sizeRes.result
      ? { width: sizeRes.result.width, height: sizeRes.result.height }
      : { width: 1404, height: 1872 };
    const pageMaxX = PointUtils.getRealMaxX(pageSize);
    const pageMaxY = PointUtils.getRealMaxY(pageSize);
    const zero = { x: 0, y: 0 };

    const restored: any[] = [];
    for (const he of hiddenToRestore) {
      const el = await buildElement(he.data, page, he.userData ?? null, zero, pageMaxX, pageMaxY, 0, 0);
      if (el) restored.push(el);
      else console.error(`${LOG} buildElement returned null restoring hidden kind=${he.data.kind}`);
    }
    if (restored.length > 0) {
      const ins: any = await PluginFileAPI.insertElements(filePath, page, restored);
      if (!ins?.success) {
        console.error(`${LOG} insertElements (restore hidden) failed res=${JSON.stringify(ins)}`);
      }
      for (const el of restored) { try { el.recycle?.(); } catch { /* ignore */ } }
      await PluginNoteAPI.saveCurrentNote();
    }
  }

  // 6. Update icon userData.
  const ok = await writeSection(filePath, page, iconElement, updatedSection);
  if (!ok) console.error(`${LOG} failed to update section userData after recollapse`);

  await PluginCommAPI.reloadFile();
}
