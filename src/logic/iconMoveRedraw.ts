import { PluginCommAPI, PluginFileAPI, PluginNoteAPI, PointUtils, Rect } from 'sn-plugin-lib';
import { HANDLE_HIT_PAD, ICON_HIT_PAD, LOG, SCHEMA_VERSION, ZONE_MARGIN, dlog } from '../constants';
import { growZoneToHandle, handleRectForZone, padded, projectIconOutsideZone, rectContains, rectsOverlap, stretchZoneToIcon } from '../utils/geometryHelpers';
import { contentBoundingBox, getPageSize, resolveLinkMemberIndices, serializeElement } from '../utils/elementSerializer';
import { readUserData, writeSection } from '../utils/userDataManager';
import { ensureAllPermissions } from '../utils/permissions';
import { CollapseSection, CollapsedElement } from '../model/types';
import { expandedCount, expandedEntries, forgetSection, getExpandedEntry, noteSectionExpanded } from './expandedRegistry';
import { expandOne } from './expandAction';
import { createUnderlineElement, findNameElements, findUnderlineElements, rebuildNameElements } from './nameAction';
import { acquireBusy, releaseBusy } from './busy';
import { buildIconCache } from './iconPageCache';
import { gestureDelta, isTapDistance, noteGestureDown } from './tapGesture';
import { ABSORBABLE_TYPES } from './recollapseAction';
import { getCurrentFileContext, getCurrentPageNumOrNull } from '../utils/currentFile';
import { showBusyView, closeBusyView } from '../utils/busyView';
import { reloadFileWithTimeout } from '../utils/reloadFile';

// CR-008: which of a section's two draggable controls a gesture grabbed.
type DragKind = 'icon' | 'handle';

// CR-009: a finger never actually relocates a page element (unlike the
// pencil), so a finger-triggered redraw carries the raw down-to-up delta and
// synthesizes the intended new position from it instead of reading one back.
type FingerDelta = { dx: number; dy: number };

function isQualifyingFinger(toolType: number | undefined, pointerCount: number | undefined): boolean {
  return toolType === 1 && pointerCount === 1;
}

// Section/control the current gesture grabbed (set on DOWN, consumed on UP).
let dragCandidateId: string | null = null;
let dragCandidateKind: DragKind | null = null;
let dragCandidateIsFinger = false;

// The plugin host does NOT pump the JS event loop while idle — timers only fire
// when a native event or an in-flight await ticks the runtime. So we can't defer
// the redraw through a setTimeout debounce (it would never fire after the pen
// lifts); we run it directly from the UP event and coalesce rapid drags with the
// busy guard + a re-run flag instead.
let rerunId: string | null = null;
let rerunKind: DragKind | null = null;
let rerunFingerDelta: FingerDelta | undefined;

async function kickRedraw(id: string, kind: DragKind, fingerDelta?: FingerDelta): Promise<void> {
  if (!getExpandedEntry(id)) return;
  if (!acquireBusy()) {
    // A redraw or a button op is in flight; remember to redraw once it frees up.
    // The in-flight op's finally is on a pumped loop, so the re-run actually runs.
    rerunId = id;
    rerunKind = kind;
    rerunFingerDelta = fingerDelta;
    return;
  }
  try {
    do {
      const target = rerunId ?? id;
      const targetKind = rerunId ? rerunKind! : kind;
      const targetFingerDelta = rerunId ? rerunFingerDelta : fingerDelta;
      rerunId = null;
      rerunKind = null;
      rerunFingerDelta = undefined;
      if (!getExpandedEntry(target)) continue;
      try {
        await redrawSectionBox(target, targetKind, targetFingerDelta);
      } catch (e) {
        console.error(`${LOG} live redraw failed: ${e}`);
      }
    } while (rerunId); // another drag landed while we were redrawing — coalesce it
  } finally {
    releaseBusy();
  }
}

// ACTION_DOWN: in-memory gate (no SDK call) — did this touch start near one of
// our expanded sections' icons or resize handles? If not, the UP handler no-ops.
export function onMotionDown(x: number, y: number, toolType?: number, pointerCount?: number): void {
  dragCandidateId = null;
  dragCandidateKind = null;
  dragCandidateIsFinger = isQualifyingFinger(toolType, pointerCount);
  noteGestureDown(x, y);
  if (expandedCount() === 0) return;
  for (const [id, e] of expandedEntries()) {
    if (rectContains(padded(e.iconRect, ICON_HIT_PAD), x, y)) {
      dragCandidateId = id;
      dragCandidateKind = 'icon';
      return;
    }
    if (rectContains(padded(handleRectForZone(e.zoneRect), HANDLE_HIT_PAD), x, y)) {
      dragCandidateId = id;
      dragCandidateKind = 'handle';
      return;
    }
  }
}

// ACTION_UP: if the gesture grabbed an expanded section's icon or handle and
// actually moved (not a tap/select), redraw that section. CR-009: re-qualify
// finger-ness at UP too — if DOWN and UP disagree (e.g. a second finger joined
// mid-gesture), the gesture isn't trustworthy enough to synthesize a delta
// from, so drop it entirely rather than guess.
export function onMotionUp(x: number, y: number, toolType?: number, pointerCount?: number): void {
  const id = dragCandidateId;
  const kind = dragCandidateKind;
  const wasFinger = dragCandidateIsFinger;
  dragCandidateId = null;
  dragCandidateKind = null;
  dragCandidateIsFinger = false;
  if (!id || !kind) return;
  if (isTapDistance(x, y)) return; // tap/select
  if (!getExpandedEntry(id)) return;
  const isFinger = isQualifyingFinger(toolType, pointerCount);
  if (wasFinger !== isFinger) return; // inconsistent gesture — don't guess
  void kickRedraw(id, kind, wasFinger ? gestureDelta(x, y) : undefined);
}

// Full live redraw: re-fill the mask AND re-place the strokes at the stretched
// zone. Re-serializes the on-page strokes per drag (rare op). Reuses expandOne so
// z-order and stroke links match a normal expand. `trigger` says which control
// was dragged — the icon (existing behavior) or the bottom-right resize handle
// (CR-008): only the zone-computation step and the name-relocation step differ
// between the two; everything else (B-020's absorb-or-protect scan, B-022's
// containment clamp, the stash/delete/reinsert sequence) is shared. `fingerDelta`
// (CR-009), when present, means the dragged control's page position never
// actually changed (a finger doesn't relocate elements) — the freshly-read
// rect is overwritten by translating it by this delta right after it's read,
// so everything downstream (moved-check, name delta, zone geometry) operates
// on the synthesized position exactly as it already does for a real move.
async function redrawSectionBox(id: string, trigger: DragKind, fingerDelta?: FingerDelta): Promise<void> {
  const entry = getExpandedEntry(id);
  if (!entry) return;

  // Denial degrades the same way a missed live redraw already does (SPEC.md
  // Persistence requirements): no content is lost, the section stays
  // correctly recoverable via a real Recollapse/Expand — just this
  // convenience redraw is skipped.
  const permitted = await ensureAllPermissions(
    'Collapse/Expand needs permission to change the page to redraw this section.',
  );
  if (!permitted) return;

  const ctx = await getCurrentFileContext();
  if (!ctx) return;
  const { filePath, page } = ctx;

  // Flush, then READ before dismissing: only setLassoBoxState (which cancels the
  // selection) if the icon actually moved. saveCurrentNote surfaces a real drag
  // to getElements, so a move reads moved=true while a select leaves the icon put
  // (moved=false → return untouched). This is what lets selecting and moving
  // coexist — the gate alone can't tell them apart.
  await PluginNoteAPI.saveCurrentNote();

  const allRes: any = await PluginFileAPI.getElements(page, filePath);
  const all: any[] = allRes?.success && Array.isArray(allRes.result) ? allRes.result : [];

  let iconEl: any = null;
  let iconRect: Rect | null = null;
  let handleRect: Rect | null = null;
  const partEls: any[] = [];
  const removeNums: number[] = [];
  for (const el of all) {
    const ud = readUserData(el);
    if (!ud) continue;
    if (ud.kind === 'plug' && ud.section?.id === id) {
      iconEl = el;
      if (el?.textBox?.textRect) iconRect = el.textBox.textRect;
    } else if (ud.kind === 'part' && ud.id === id) {
      partEls.push(el);
      if (typeof el.numInPage === 'number') removeNums.push(el.numInPage);
    } else if ((ud.kind === 'mask' || ud.kind === 'frame') && ud.id === id && typeof el.numInPage === 'number') {
      removeNums.push(el.numInPage);
    } else if (ud.kind === 'handle' && ud.id === id) {
      if (el?.textBox?.textRect) handleRect = el.textBox.textRect;
      if (typeof el.numInPage === 'number') removeNums.push(el.numInPage);
    }
  }
  const nameEls = findNameElements(all, id);
  if (!iconEl || !iconRect) return; // icon gone (recollapsed elsewhere)
  if (trigger === 'handle' && !handleRect) return; // handle gone (recollapsed elsewhere)

  // CR-009: synthesize the moved-to position from the raw finger delta instead
  // of trusting the freshly-read (unchanged) page rect — see this function's
  // own doc comment above.
  if (fingerDelta) {
    if (trigger === 'icon') {
      iconRect = {
        left: iconRect.left + fingerDelta.dx,
        top: iconRect.top + fingerDelta.dy,
        right: iconRect.right + fingerDelta.dx,
        bottom: iconRect.bottom + fingerDelta.dy,
      };
    } else {
      handleRect = {
        left: handleRect!.left + fingerDelta.dx,
        top: handleRect!.top + fingerDelta.dy,
        right: handleRect!.right + fingerDelta.dx,
        bottom: handleRect!.bottom + fingerDelta.dy,
      };
    }
  }

  if (trigger === 'icon') {
    // Did the icon actually move since we last drew the box? (sub-pixel = no)
    // For a finger trigger this is never true by construction — iconRect was
    // just translated by a delta onMotionUp already confirmed exceeds the tap
    // threshold — but the check is harmless to leave in place either way.
    const moved =
      Math.abs(iconRect.left - entry.iconRect.left) > 1 ||
      Math.abs(iconRect.top - entry.iconRect.top) > 1;
    if (!moved) {
      noteSectionExpanded(id, iconRect, entry.zoneRect);
      return;
    }
  }

  // Confirmed drag (icon moved, or handle release reached here) — NOW dismiss
  // the selection (commit) before mutating.
  const lassoRes: any = await PluginCommAPI.setLassoBoxState(2);
  if (!lassoRes?.success) console.error(`${LOG} live redraw setLassoBoxState res=${JSON.stringify(lassoRes)}`);

  // Show the busy overlay for the rebuild (same heavy path as a normal expand).
  // Only past the moved check, so a tap/select never flashes it; closed in the
  // finally regardless of which early return fires.
  let viewShown = await showBusyView('live redraw');
  try {
    // Re-serialize the current on-page content so we can rebuild it above a fresh
    // fill. Stroke links are resolved later, once any newly-absorbed content
    // (below) is merged in too.
    let fresh: CollapsedElement[] = [];
    for (const el of partEls) {
      const data = await serializeElement(el);
      if (data) fresh.push({ numInPage: el.numInPage, data });
    }
    if (fresh.length === 0) { return; }

    const pageSize = await getPageSize(filePath, page);

    const existing = readUserData(iconEl);
    const base = existing?.kind === 'plug' ? existing.section : null;

    // The name (if any) rigidly follows the icon's own drag delta — the only
    // way it ever moves programmatically. The icon doesn't move under a
    // handle-triggered resize, so the name doesn't either (unchanged spec).
    if (trigger === 'icon' && nameEls.length > 0) {
      const nameDx = iconRect.left - entry.iconRect.left;
      const nameDy = iconRect.top - entry.iconRect.top;
      const serializedName: CollapsedElement[] = [];
      for (const el of nameEls) {
        const data = await serializeElement(el);
        if (data) serializedName.push({ numInPage: el.numInPage, data });
      }
      // Safe two-point EMR delta — convert the "from" (last-drawn) and "to"
      // (current) icon points independently, then subtract. See
      // rebuildNameElements's doc comment for why converting a bare delta
      // directly would be wrong.
      const nameEmrFrom = PointUtils.androidPoint2Emr({ x: entry.iconRect.left, y: entry.iconRect.top }, pageSize);
      const nameEmrTo = PointUtils.androidPoint2Emr({ x: iconRect.left, y: iconRect.top }, pageSize);
      const nameEmrDelta = { x: nameEmrTo.x - nameEmrFrom.x, y: nameEmrTo.y - nameEmrFrom.y };
      const namePageMaxX = PointUtils.getRealMaxX(pageSize);
      const namePageMaxY = PointUtils.getRealMaxY(pageSize);
      const rebuiltName = await rebuildNameElements(serializedName, id, page, nameDx, nameDy, nameEmrDelta, namePageMaxX, namePageMaxY);
      if (rebuiltName.length > 0) {
        // Underline follows the same shift — inserted in the same batch as
        // the name.
        const oldNameBBox = contentBoundingBox(serializedName, pageSize);
        const underlineEl = oldNameBBox
          ? await createUnderlineElement({
              left: oldNameBBox.left + nameDx,
              top: oldNameBBox.top + nameDy,
              right: oldNameBBox.right + nameDx,
              bottom: oldNameBBox.bottom + nameDy,
            }, page, id)
          : null;
        const nameInsertBatch = underlineEl ? [...rebuiltName, underlineEl] : rebuiltName;
        const insName: any = await PluginFileAPI.insertElements(filePath, page, nameInsertBatch);
        if (insName?.success) {
          for (const el of nameEls) {
            if (typeof el.numInPage === 'number') removeNums.push(el.numInPage);
          }
          for (const el of findUnderlineElements(all, id)) {
            if (typeof el.numInPage === 'number') removeNums.push(el.numInPage);
          }
        } else {
          console.error(`${LOG} live redraw: failed to relocate section name res=${JSON.stringify(insName)}`);
        }
        for (const el of nameInsertBatch) { try { el.recycle?.(); } catch { /* ignore */ } }
      }
    }

    const bbox = contentBoundingBox(fresh, pageSize);
    if (!bbox) { return; }

    // The zone/absorb logic below needs to know the section's shape *before*
    // this redraw regardless of trigger — both as the growth basis for a
    // handle-triggered resize, and to isolate what a resize newly covered
    // (B-020, below) for either trigger.
    const oldZone: Rect | null = base ? {
      left: base.iconRect.left + base.relativeRect.left,
      top: base.iconRect.top + base.relativeRect.top,
      right: base.iconRect.left + base.relativeRect.left + base.relativeRect.width,
      bottom: base.iconRect.top + base.relativeRect.top + base.relativeRect.height,
    } : null;
    if (trigger === 'handle' && !oldZone) {
      console.error(`${LOG} live redraw (handle): no persisted zone found for section=${id} — aborting`);
      return;
    }

    // Icon trigger: shiftDx/shiftDy intentionally ignored — a live redraw's
    // content must stay exactly where it is (only the zone reshapes to reach
    // a dragged icon), unlike Recollapse's icon-overlap-after-absorb case.
    // Handle trigger (CR-008): the corner moves directly to wherever the
    // handle was dropped — no analogous shift at all, since the handle
    // always sits exactly at the corner it drags, nothing to avoid
    // overlapping. `handleRect` is non-null here: the earlier
    // `if (trigger === 'handle' && !handleRect) return` guard already
    // ensured that for this trigger.
    const zone = trigger === 'icon'
      ? stretchZoneToIcon(bbox, ZONE_MARGIN, iconRect).zone
      : growZoneToHandle(oldZone!, bbox, ZONE_MARGIN, {
          x: (handleRect!.left + handleRect!.right) / 2,
          y: (handleRect!.top + handleRect!.bottom) / 2,
        });

    // CR-006/B-020: grow preservedNums with whatever's newly caught under the
    // stretched zone — but only content that overlaps the NEW zone and did
    // NOT already overlap the OLD zone (the section's shape just before this
    // redraw). Checking the new zone alone (B-020) can't tell "covered
    // because the zone just grew" (REQ-230, must protect) apart from
    // "already sitting here for some other reason, e.g. drawn after Expand"
    // (REQ-200, must stay absorbable) — both look identical under that check.
    // Comparing against the old zone is what actually isolates the delta the
    // resize itself caused.
    const priorPreserved = new Set<number>(base?.preservedNums ?? []);
    const newlyCovered: number[] = [];
    // B-020: content already inside the zone before this resize (e.g. drawn
    // since Expand) isn't "newly covered" — it's eligible content the user put
    // there themselves (REQ-200/210). Absorb it now (tag + reinsert as CE_PART
    // alongside the section's own content) instead of leaving it an untracked
    // bystander that would otherwise vanish under the freshly-redrawn mask
    // until an actual Recollapse got around to it.
    for (const el of all) {
      if (readUserData(el) !== null) continue; // tagged — ours or another section's
      if (typeof el.numInPage !== 'number' || priorPreserved.has(el.numInPage)) continue;
      const data = await serializeElement(el);
      if (!data) continue;
      const elBbox = contentBoundingBox([{ numInPage: el.numInPage, data }], pageSize);
      if (!elBbox || !rectsOverlap(elBbox, zone)) continue;
      if (oldZone && rectsOverlap(elBbox, oldZone)) {
        if (ABSORBABLE_TYPES.has(el.type)) {
          fresh.push({ numInPage: el.numInPage, data });
          removeNums.push(el.numInPage);
        }
        continue;
      }
      newlyCovered.push(el.numInPage);
    }
    fresh = await resolveLinkMemberIndices(fresh);
    const preservedNums = newlyCovered.length > 0 ? [...priorPreserved, ...newlyCovered] : base?.preservedNums;

    // B-022: content-containment clamping in stretchZoneToIcon can leave the
    // icon overlapping the zone (the guarantee that used to keep it clear was
    // traded away in favor of never excluding content). Project it to just
    // outside the zone's nearest edge.
    const projectedIcon = projectIconOutsideZone(iconRect, zone, ZONE_MARGIN);
    const iconR: Rect = {
      left: Math.round(projectedIcon.left),
      top: Math.round(projectedIcon.top),
      right: Math.round(projectedIcon.right),
      bottom: Math.round(projectedIcon.bottom),
    };
    // CR-009: write back unconditionally, not just when projection actually
    // moved it — expandOne's own internal re-read of the icon's page position
    // is what actually places the rebuilt zone, so a finger-synthesized
    // position (never independently written to the page by anything else)
    // has to be committed here regardless of whether B-022's projection fired.
    // Harmless no-op for a pencil drag, where this was already correct.
    if (iconEl?.textBox) {
      iconEl.textBox.textRect = iconR;
    }
    const temp: CollapseSection = {
      schemaVersion: base?.schemaVersion ?? SCHEMA_VERSION,
      id,
      iconRect: iconR,
      relativeRect: {
        left: Math.round(zone.left) - iconR.left,
        top: Math.round(zone.top) - iconR.top,
        width: Math.round(zone.right - zone.left),
        height: Math.round(zone.bottom - zone.top),
      },
      collapsedElements: fresh,
      isExpanded: true,
      // Carry preservedNums forward (grown above with anything newly covered
      // by this resize) — recapturing from scratch would misfile these
      // (already on-page) strokes as pre-existing.
      preservedNums,
    };

    // CRASH-SAFETY: stash `fresh` into the icon's userData (isExpanded stays
    // true) BEFORE deleting the old parts/masks/frame. While expanded, those
    // on-page elements were the only durable copy; this snapshot means a crash
    // between the stash and the rebuild below still leaves the content durable.
    const { ok: stashOk } = await writeSection(filePath, page, iconEl, temp, iconEl);
    if (!stashOk) {
      console.error(`${LOG} live redraw failed to stash content before delete — aborting, parts left in place`);
      return;
    }

    // REQ-340/CR-009: re-verify we're still on the page this whole operation
    // has assumed throughout (captured once, at entry, as `page`) before the
    // point of no return — a page-turn firing mid-operation (most plausible
    // via a finger gesture also being read as a native swipe) would otherwise
    // have every write below still explicitly targeting the old page number
    // while the native app's own state has moved on, which is exactly the
    // kind of interleaving this SDK has shown itself unstable under. Applied
    // unconditionally (pencil included) — cheap, and closes the same
    // theoretical gap there too. Abort before deleting anything: the section
    // is left exactly as it was, nothing to recover from.
    const pageNow = await getCurrentPageNumOrNull();
    if (pageNow !== page) {
      console.error(`${LOG} live redraw: page changed mid-operation (was ${page}, now ${pageNow}) — aborting before delete`);
      return;
    }

    // Delete the old content + fill + outline, then re-expand in place. The temp
    // section is anchored to the CURRENT icon (emrDelta=0 ⇒ content rebuilds where
    // it is); relativeRect places the mask at the stretched zone.
    if (removeNums.length > 0) {
      const del: any = await PluginFileAPI.deleteElements(filePath, page, removeNums);
      if (!del?.success) console.error(`${LOG} live redraw deleteElements failed res=${JSON.stringify(del)}`);
    }

    // B-018-PROBE2 experiment: insertElements right after this delete has been
    // confirmed to silently no-op (reports success, nothing lands) specifically
    // in this redraw sequence. Testing whether a saveCurrentNote() flush here
    // lets the native side settle before the re-insert, the same idiom already
    // used elsewhere in this codebase before a mutating sequence.
    await PluginNoteAPI.saveCurrentNote();

    // B-023: pass `all` (already fetched above) so expandOne can clean up any
    // stale leftovers from a prior failed attempt without a second fetch.
    const reinsertOk = await expandOne(temp, iconEl, filePath, page, false, all); // capturePreserved defaults false
    if (!reinsertOk) {
      // B-018: expandOne already alerted and reverted the icon to `temp`'s own
      // state on failure — but `temp` has isExpanded:true with the content
      // only in its userData backup, since the old on-page parts were already
      // deleted above. That combination isn't one any normal tap can recover
      // from (isExpanded:true routes the next tap to Recollapse, which finds
      // nothing on the page and aborts). Explicitly fall back to a clean
      // collapsed state instead — the content is safely in `temp`'s backup,
      // so this is a real, working "undo" of the redraw, not a data loss.
      const { ok: revertOk } = await writeSection(filePath, page, iconEl, { ...temp, isExpanded: false }, iconEl);
      if (!revertOk) console.error(`${LOG} live redraw: failed to fall back to collapsed after a failed re-expand — section may be left inconsistent`);
      forgetSection(id);
      return;
    }
    // B-018-PROBE2 experiment: the data itself is now correct without this
    // (confirmed via manual screen refresh), but the on-screen render was
    // stale afterward — added the saveCurrentNote() flush above shifted
    // something such that this path now needs an explicit reload to
    // refresh the display, unlike every other call site (see BUGS/B-017.md).
    // Testing whether reloadFile() now actually resolves here too (it used
    // to reliably hang in this exact sequence, before the flush above).
    await reloadFileWithTimeout();
    // Rebuild (not just invalidate) the icon cache eagerly, while the
    // working bubble is already up — moves the cost here instead of paying
    // it silently on the user's next tap.
    await buildIconCache(filePath, page);
    dlog(`${LOG} live full redraw section=${id} icon=[${iconR.left},${iconR.top}] zone=[${Math.round(zone.left)},${Math.round(zone.top)},${Math.round(zone.right)},${Math.round(zone.bottom)}]`);
  } finally {
    if (viewShown) {
      await closeBusyView('live redraw');
    }
  }
}
