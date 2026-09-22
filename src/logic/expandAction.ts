import { PluginCommAPI, PluginFileAPI, PluginNoteAPI, PointUtils, Rect } from 'sn-plugin-lib';
import { CE_PART_PREFIX, dlog, ICON_GLYPH, ICON_GLYPH_EXPANDED, LOG } from '../constants';
import { buildElement, contentBoundingBox, getPageSize, serializeElement } from '../utils/elementSerializer';
import { getIconByNum, iconRectFromElements, isUnstableNoteError, readUserData, writeSection } from '../utils/userDataManager';
import { createMaskElements } from '../utils/maskHelpers';
import { rectsOverlap } from '../utils/geometryHelpers';
import { ensureAllPermissions } from '../utils/permissions';
import { rebuildStrokeLinks, strokeLinkMemberIndices } from './strokeLinkExpand';
import { forgetSection, noteSectionExpanded } from './expandedRegistry';
import { buildIconCache } from './iconPageCache';
import { CollapseSection } from '../model/types';
import { alertOverBusyView } from '../utils/busyView';
import { reloadFileWithTimeout } from '../utils/reloadFile';

// One-time, best-effort warm-up so live icon-drag redraw survives a plugin
// restart: expandedRegistry is JS-memory-only, so a restart clears it and
// dragging an already-expanded section's icon would otherwise do nothing
// until the section goes through a real Expand/Recollapse. Reuses the tap
// cache's page scan (already extracts every icon + rect) instead of a
// second independent getElements pass. Only covers the page open at call
// time — a section expanded on a different page stays dormant until
// visited, same limitation the tap cache already has.
//
// Known limitation (B-013): reliable after a plain process restart
// (force-stop), but not after a full device reboot — see BUGS/B-013.md.
// Investigated and not fixed; documented in CHANGES.md / README.md instead.
export async function rehydrateExpandedRegistry(filePath: string, page: number): Promise<void> {
  try {
    const icons = await buildIconCache(filePath, page);
    for (const icon of icons) {
      if (!icon.section.isExpanded) continue;
      // contentBBox has no functional reader (redrawSectionBox always
      // recomputes it fresh from the live CE_PART elements) — the icon's own
      // rect is a cheap stand-in, overwritten on the next real redraw/expand.
      noteSectionExpanded(icon.id, icon.rect, icon.rect, icon.iconEl?.numInPage);
    }
  } catch (e) {
    dlog(`${LOG} rehydrateExpandedRegistry failed: ${e}`);
  }
}

// Expand ONE section: insert its mask + restored content (stroke links via
// rebuildStrokeLinks) and flip the icon's userData to isExpanded. Does NOT
// saveCurrentNote / setLassoBoxState — expandSections does those once around
// the loop so N sections cost a single flush + lasso dismiss.
export async function expandOne(
  section: CollapseSection,
  iconElement: any,
  filePath: string,
  page: number,
  capturePreserved: boolean = false,
): Promise<boolean> {
  dlog(`${LOG} SIZE expand icon userData=${iconElement?.userData?.length ?? 0} bytes, collapsed=${section.collapsedElements?.length ?? 0} element(s)`);

  const tPrep = Date.now();
  // One getElements gives the icon's CURRENT rect (the lassoed element reports a
  // stale rect after a move) and, on a real expand, preservedNums = the nums of
  // every untagged element on the page now (pre-existing content). On a live
  // redraw we carry the existing preservedNums forward instead of re-capturing
  // (which would misfile the new strokes as pre-existing).
  // Fast path: fetch only the icon (one element) instead of marshalling every
  // element (the full getElements is ~7x more expensive on a dense page). When
  // capturePreserved is also needed, this still costs a real getElements — it
  // MUST be filtered to untagged-only, same as the fallback path below, not a
  // raw getElementNumList: a later Recollapse's own fast path (fastSectionElements)
  // trusts preservedNums for exact-number exclusion with no supplementary tag
  // check, so an unfiltered list can wrongly exclude this section's own
  // mask/frame/part/name elements from ever being found.
  // Fall back to a full getElements only if the icon num is stale/missing.
  const tGE = Date.now();
  let iconRectNow: any;
  let freshIconEl: any;
  let preservedCandidates: any[] | undefined; // untagged elements, filtered by zone overlap below — only gathered when capturePreserved
  const fastIcon = await getIconByNum(filePath, page, iconElement?.numInPage, section.id);
  if (fastIcon) {
    freshIconEl = fastIcon;
    iconRectNow = fastIcon.textBox?.textRect ?? section.iconRect;
    if (capturePreserved) {
      const preservedRes: any = await PluginFileAPI.getElements(page, filePath);
      const preservedAll: any[] = preservedRes?.success && Array.isArray(preservedRes.result) ? preservedRes.result : [];
      preservedCandidates = preservedAll.filter((el) => readUserData(el) == null && typeof el.numInPage === 'number');
    }
    dlog(`${LOG} PERF expand read(fast getElement+numList)=${Date.now() - tGE}ms`);
  } else {
    const allAtExpandRes: any = await PluginFileAPI.getElements(page, filePath);
    const allAtExpand: any[] = allAtExpandRes?.success && Array.isArray(allAtExpandRes.result) ? allAtExpandRes.result : [];
    iconRectNow = iconRectFromElements(allAtExpand, section, iconElement);
    freshIconEl = allAtExpand.find((el) => {
      const ud = readUserData(el);
      return ud?.kind === 'plug' && ud.section?.id === section.id;
    }) ?? iconElement;
    if (capturePreserved) {
      preservedCandidates = allAtExpand.filter((el) => readUserData(el) == null && typeof el.numInPage === 'number');
    }
    dlog(`${LOG} PERF expand read(fallback full getElements)=${Date.now() - tGE}ms total=${allAtExpand.length} el`);
  }
  const contentRect: Rect = {
    left: iconRectNow.left + section.relativeRect.left,
    top: iconRectNow.top + section.relativeRect.top,
    right: iconRectNow.left + section.relativeRect.left + section.relativeRect.width,
    bottom: iconRectNow.top + section.relativeRect.top + section.relativeRect.height,
  };

  const pageSize = await getPageSize(filePath, page);

  // CR-006: zone-scoped, not whole-page — only untagged content actually
  // positioned inside the zone at expand time is protected from Recollapse's
  // absorb-scan (REQ-220). Content elsewhere on the page that the user later
  // drags in stays unprotected, so a later Recollapse absorbs it (REQ-210).
  // See redrawSectionBox for the matching incremental grow-on-resize (REQ-230).
  let preservedNums: number[] | undefined;
  if (capturePreserved) {
    const tPreserve = Date.now();
    preservedNums = [];
    for (const el of preservedCandidates ?? []) {
      const data = await serializeElement(el);
      if (!data) continue;
      const bbox = contentBoundingBox([{ numInPage: el.numInPage, data }], pageSize);
      if (bbox && rectsOverlap(bbox, contentRect)) preservedNums.push(el.numInPage);
    }
    dlog(`${LOG} PERF expand preserve-scan=${Date.now() - tPreserve}ms candidates=${preservedCandidates?.length ?? 0} preserved=${preservedNums.length}`);
  } else {
    preservedNums = section.preservedNums;
  }

  // Content moves by the icon's own movement, plus a one-time extra shift a
  // prior Recollapse may have queued (contentShift — see BUGS/B-011.md /
  // CollapseSection.contentShift). Both apply uniformly to every restored
  // element, so their relative layout to each other never changes — only
  // their position relative to the icon does, which is fine here since the
  // user didn't move the icon to cause this.
  const shiftDx = section.contentShift?.dx ?? 0;
  const shiftDy = section.contentShift?.dy ?? 0;
  const dx = (iconRectNow.left - section.iconRect.left) + shiftDx;
  const dy = (iconRectNow.top - section.iconRect.top) + shiftDy;

  // Safe two-point EMR delta (see rebuildNameElements's doc comment for why
  // a bare delta can't just be converted directly): "to" is the icon's new
  // position plus the queued content shift, "from" is the icon's saved
  // position — independently converted, then subtracted.
  const emrNow = PointUtils.androidPoint2Emr({ x: iconRectNow.left + shiftDx, y: iconRectNow.top + shiftDy }, pageSize);
  const emrSaved = PointUtils.androidPoint2Emr({ x: section.iconRect.left, y: section.iconRect.top }, pageSize);
  const emrDelta = { x: emrNow.x - emrSaved.x, y: emrNow.y - emrSaved.y };
  const pageMaxX = PointUtils.getRealMaxX(pageSize);
  const pageMaxY = PointUtils.getRealMaxY(pageSize);
  dlog(`${LOG} PERF expand prep(iconrect+pagesize)=${Date.now() - tPrep}ms`);

  // The section's name (if any) is never touched by Expand — it only moves
  // when the user explicitly drags the icon while expanded (iconMoveRedraw.ts).
  // A collapsed-icon move leaves the name exactly where it is.

  // Register for live box redraw on icon drag. Content bbox shifted by (dx, dy)
  // (the same delta strokes are built with) = its absolute on-page bbox.
  const baseBBox = contentBoundingBox(section.collapsedElements, pageSize);
  if (baseBBox) {
    noteSectionExpanded(section.id, iconRectNow, {
      left: baseBBox.left + dx,
      top: baseBBox.top + dy,
      right: baseBBox.right + dx,
      bottom: baseBBox.bottom + dy,
    }, freshIconEl?.numInPage ?? iconElement?.numInPage); // icon num lets recollapse fetch it without a full scan
  }

  // Stroke-link members are re-inserted out-of-band by rebuildStrokeLinks, so
  // exclude them from the main content batch here.
  const memberIndexSet = strokeLinkMemberIndices(section.collapsedElements);
  const hasStrokeLinks = section.collapsedElements.some((ce) => ce.data.kind === 'link' && ce.data.category === 1);

  const tBuild = Date.now();
  // Mask rings first so they sit below the collapsed content.
  const maskElements = await createMaskElements(contentRect, page, section.id);

  const otherElements: any[] = [];
  for (let i = 0; i < section.collapsedElements.length; i++) {
    if (memberIndexSet.has(i)) continue; // inserted by rebuildStrokeLinks
    const ce = section.collapsedElements[i];
    const el = await buildElement(ce.data, page, CE_PART_PREFIX + section.id, emrDelta, pageMaxX, pageMaxY, dx, dy);
    if (el) otherElements.push(el);
    else if (!(ce.data.kind === 'link' && ce.data.category === 1)) console.error(`${LOG} buildElement returned null for kind=${ce.data.kind}`);
  }
  dlog(`${LOG} PERF expand build=${Date.now() - tBuild}ms`);

  let insertOk = true;
  const tIns = Date.now();
  let insertUnstable = false;
  if (!hasStrokeLinks) {
    const batch = [...maskElements, ...otherElements];
    if (batch.length > 0) {
      // B-018: insertElements can report success without the elements
      // actually landing. The very next step clears the icon's
      // collapsedElements backup based on `insertOk` alone — if that trusts
      // a lie, the content is gone from both the page and the backup. Verify
      // by re-reading and counting this section's tagged elements. A
      // reported *failure* is safe to retry (nothing landed yet); a
      // reported success with a short count is NOT retried by re-inserting
      // — the batch might have partially landed, and blindly re-inserting
      // the same elements risks duplicating whatever did — only the read
      // is retried, in case it's a visibility lag rather than a real gap.
      insertOk = false;
      for (let attempt = 0; attempt < 3 && !insertOk; attempt++) {
        const ins: any = await PluginFileAPI.insertElements(filePath, page, batch);
        if (!ins?.success) {
          console.error(`${LOG} insertElements failed res=${JSON.stringify(ins)}`);
          insertUnstable = isUnstableNoteError(ins);
          if (insertUnstable) break;
          continue; // nothing landed — safe to retry the insert itself
        }
        for (let readAttempt = 0; readAttempt < 3 && !insertOk; readAttempt++) {
          await reloadFileWithTimeout(); // B-018: without this, the read below can miss a just-landed insert
          const checkRes: any = await PluginFileAPI.getElements(page, filePath);
          const check: any[] = checkRes?.success && Array.isArray(checkRes.result) ? checkRes.result : [];
          const landed = check.filter((el) => {
            const ud = readUserData(el);
            return ud != null && (ud.kind === 'part' || ud.kind === 'mask' || ud.kind === 'frame') && ud.id === section.id;
          }).length;
          insertOk = landed >= batch.length;
          if (!insertOk) console.error(`${LOG} expand: insertElements reported success but only ${landed}/${batch.length} tagged elements found (read attempt ${readAttempt}) — re-reading`);
        }
        break; // don't re-insert after a reported success either way — avoid duplicating a partial land
      }
      for (const el of batch) { try { el.recycle?.(); } catch { /* ignore */ } }
    }
  } else {
    // rebuildStrokeLinks owns the whole insert sequence (it needs a reload per
    // link to recover the members' fresh nums).
    insertOk = await rebuildStrokeLinks({
      filePath, page, collapsedElements: section.collapsedElements,
      sectionId: section.id, emrDelta, pageMaxX, pageMaxY, dx, dy,
      maskElements, otherElements,
    });
  }
  dlog(`${LOG} PERF expand insertElements=${Date.now() - tIns}ms`);

  // No saveCurrentNote (would clobber the inserts with the stale cached copy) —
  // the inserts are already visible without an explicit reload on this SDK
  // build (see BUGS/B-017.md). While expanded the content lives on the page as
  // CE_PART and recollapse rebuilds the payload from it, so drop
  // collapsedElements from userData — but only if the insert succeeded,
  // keeping exactly one durable copy (userData while collapsed, page while
  // expanded).
  // B-018: isExpanded used to be set to `true` unconditionally here, even
  // when insertOk is false — leaving the icon claiming "expanded" while
  // simultaneously keeping the pre-expand backup (collapsedElements) intact.
  // That combination is itself an inconsistent, hard-to-recover state: the
  // very next tap reads isExpanded and tries to Recollapse a section whose
  // content may never have actually landed on the page. On failure, revert
  // to the pre-expand state in full instead — only iconRect (the icon's own
  // real position) is trustworthy regardless of insertOk.
  const expandedState: CollapseSection = insertOk
    ? {
        ...section,
        isExpanded: true,
        iconRect: iconRectNow,
        collapsedElements: [],
        preservedNums,
        // Consumed above (baked into dx/dy/emrDelta) — the strokes are now
        // physically at their shifted position, so clear it rather than
        // leaving a stale value to leak forward via the ...section spread.
        contentShift: undefined,
      }
    : { ...section, iconRect: iconRectNow };

  // Flip the icon's glyph to reflect the new state — set on the same object
  // writeSection targets, so it rides along in the same modifyElements call.
  // Only flips forward on success; reverts to the collapsed glyph otherwise,
  // matching expandedState's own full revert above.
  if (freshIconEl?.textBox) freshIconEl.textBox.textContentFull = insertOk ? ICON_GLYPH_EXPANDED : ICON_GLYPH;

  const tWrite = Date.now();
  const { ok, unstableNote: writeUnstable } = await writeSection(filePath, page, iconElement, expandedState, freshIconEl);
  if (!ok) console.error(`${LOG} failed to update section userData after expand`);
  dlog(`${LOG} PERF expand writeSection=${Date.now() - tWrite}ms`);

  // On a partial failure, content remains durable in userData (collapsedElements
  // was kept above), but the page doesn't reflect "expanded" and the registry
  // shouldn't either — forget it so live-redraw doesn't act on a phantom entry.
  // If the failure was SDK error 102 (note not in a stable/foreground state —
  // e.g. the triggering tap also switched the active app away from Notes), the
  // user has no expectation anything happened, so stay silent instead of
  // alerting.
  if (!insertOk || !ok) {
    forgetSection(section.id);
    if (insertUnstable || writeUnstable) {
      console.error(`${LOG} expand aborted silently — note not in a stable state (SDK error 102)`);
    } else {
      await alertOverBusyView('expand', "Supernote couldn't complete the expand — please try again; if it persists, reopen the note.");
    }
  }
  return insertOk && ok;
}

// Expand one or more sections in a single flush + lasso dismiss: dismiss once,
// expand each. (A stroke-link section still needs its own internal reload; see
// rebuildStrokeLinks.) Loose strokes in the selection are left untouched.
export async function expandSections(
  targets: { section: CollapseSection; icon: any }[],
  filePath: string,
  page: number,
): Promise<void> {
  if (targets.length === 0) return;

  const permitted = await ensureAllPermissions(
    'Collapse/Expand needs permission to read and change the page to expand this section.',
  );
  if (!permitted) return;

  // Flush in-flight edits so the per-section icon-rect reads see current state.
  await PluginNoteAPI.saveCurrentNote();
  // Dismiss the lasso before any insert, so we never mutate with a lifted
  // selection (this also returns loose selected strokes to the page unchanged).
  const lassoRes: any = await PluginCommAPI.setLassoBoxState(2);
  if (!lassoRes?.success) console.error(`${LOG} expand setLassoBoxState res=${JSON.stringify(lassoRes)}`);

  for (const t of targets) {
    await expandOne(t.section, t.icon, filePath, page, true); // capture preservedNums
  }

  // B-017: reloadFile() removed — see collapseAction.ts's identical comment
  // and BUGS/B-017.md. Terminal call here too, nothing reads afterward.
  const tReload = Date.now();
  dlog(`${LOG} PERF expand reload=${Date.now() - tReload}ms`);
}
