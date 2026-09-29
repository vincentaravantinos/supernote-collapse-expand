import { PluginCommAPI, PluginFileAPI, PluginNoteAPI, PointUtils, Rect } from 'sn-plugin-lib';
import { HANDLE_HIT_PAD, ICON_GLYPH, ICON_HIT_PAD, LOG, SCHEMA_VERSION, ZONE_MARGIN, dlog } from '../constants';
import { growZoneToHandle, handleRectForZone, padded, projectIconOutsideZone, rectContains, rectsOverlap, relativeRectFor, sectionZone, stretchZoneToIcon } from '../utils/geometryHelpers';
import { contentBoundingBox, getPageSize, recycleAll, resolveLinkMemberIndices, serializeAll, serializeElement } from '../utils/elementSerializer';
import { deleteElementsVerified, getPageElements, isSectionBody, readUserData, writeSection } from '../utils/userDataManager';
import { ensureAllPermissions } from '../utils/permissions';
import { CollapseSection } from '../model/types';
import { expandedCount, expandedEntries, forgetSection, getExpandedEntry, noteSectionExpanded } from './expandedRegistry';
import { expandOne } from './expandAction';
import { createUnderlineElement, findNameElements, findUnderlineElements, rebuildNameElements } from './nameAction';
import { Operation, runExclusive } from './operation';
import { gestureDelta, isSingleFinger, isTapDistance, noteGestureDown } from './tapGesture';
import { ABSORBABLE_TYPES } from './recollapseAction';
import { getCurrentFileContext, getCurrentPageNumOrNull } from '../utils/currentFile';
import { alertOverBusyView } from '../utils/busyView';
import { reloadFileWithTimeout } from '../utils/reloadFile';

// Which of a section's two draggable controls a gesture grabbed.
type DragKind = 'icon' | 'handle';

// A finger never actually relocates a page element (unlike the
// pencil), so a finger-triggered redraw carries the raw down-to-up delta and
// synthesizes the intended new position from it instead of reading one back.
type FingerDelta = { dx: number; dy: number };

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
  await runExclusive('live redraw', async (op) => {
    do {
      const target = rerunId ?? id;
      const targetKind = rerunId ? rerunKind! : kind;
      const targetFingerDelta = rerunId ? rerunFingerDelta : fingerDelta;
      rerunId = null;
      rerunKind = null;
      rerunFingerDelta = undefined;
      if (!getExpandedEntry(target)) continue;
      try {
        await redrawSectionBox(op, target, targetKind, targetFingerDelta);
      } catch (e) {
        console.error(`${LOG} live redraw failed: ${e}`);
      }
    } while (rerunId); // another drag landed while we were redrawing — coalesce it
  }, {
    // A redraw or a button op is in flight; remember to redraw once it frees up.
    // The in-flight op's finally is on a pumped loop, so the re-run actually runs.
    onBusy: () => {
      rerunId = id;
      rerunKind = kind;
      rerunFingerDelta = fingerDelta;
    },
  });
}

// ACTION_DOWN: in-memory gate (no SDK call) — did this touch start near one of
// our expanded sections' icons or resize handles? If not, the UP handler no-ops.
export function onMotionDown(x: number, y: number, toolType?: number, pointerCount?: number): void {
  dragCandidateId = null;
  dragCandidateKind = null;
  dragCandidateIsFinger = isSingleFinger(toolType, pointerCount);
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
// actually moved (not a tap/select), redraw that section. Re-qualify
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
  const isFinger = isSingleFinger(toolType, pointerCount);
  if (wasFinger !== isFinger) return; // inconsistent gesture — don't guess
  void kickRedraw(id, kind, wasFinger ? gestureDelta(x, y) : undefined);
}

// Full live redraw: re-fill the mask AND re-place the strokes at the stretched
// zone. Re-serializes the on-page strokes per drag (rare op). Reuses expandOne so
// z-order and stroke links match a normal expand. `trigger` says which control
// was dragged — the icon or the bottom-right resize handle: only the
// zone-computation and name-relocation steps differ between the two; everything
// else (the absorb-or-protect scan, the containment clamp, the
// stash/delete/reinsert sequence) is shared. `fingerDelta`, when present, means
// the dragged control's page position never actually changed (a finger doesn't
// relocate elements) — the freshly-read rect is overwritten by translating it by
// this delta right after it's read, so everything downstream (moved-check, name
// delta, zone geometry) operates on the synthesized position exactly as it
// already does for a real move.
async function redrawSectionBox(op: Operation, id: string, trigger: DragKind, fingerDelta?: FingerDelta): Promise<void> {
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

  const all = await getPageElements(filePath, page);

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
    } else if (isSectionBody(ud, id)) {
      if (typeof el.numInPage === 'number') removeNums.push(el.numInPage);
      if (ud.kind === 'part') partEls.push(el);
      else if (ud.kind === 'handle' && el?.textBox?.textRect) handleRect = el.textBox.textRect;
    }
  }
  const nameEls = findNameElements(all, id);
  if (!iconEl || !iconRect) return; // icon gone (recollapsed elsewhere)
  if (trigger === 'handle' && !handleRect) return; // handle gone (recollapsed elsewhere)

  // Synthesize the moved-to position from the raw finger delta instead
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
  } else {
    // Same check for the handle, against where the last-drawn zone put it:
    // a far-away UP (e.g. a resting palm lifting) on a merely-selected handle
    // must not run a full redraw.
    const drawn = handleRectForZone(entry.zoneRect);
    const moved =
      Math.abs(handleRect!.left - drawn.left) > 1 ||
      Math.abs(handleRect!.top - drawn.top) > 1;
    if (!moved) return;
  }

  // Confirmed drag (icon or handle moved) — NOW dismiss
  // the selection (commit) before mutating.
  const lassoRes: any = await PluginCommAPI.setLassoBoxState(2);
  if (!lassoRes?.success) console.error(`${LOG} live redraw setLassoBoxState res=${JSON.stringify(lassoRes)}`);

  // Show the busy overlay for the rebuild (same heavy path as a normal expand).
  // Only past the moved check, so a tap/select never flashes it; runExclusive
  // closes it regardless of which early return fires.
  await op.showView();
  op.touched(filePath, page);

  // Re-serialize the current on-page content so we can rebuild it above a fresh
  // fill. Stroke links are resolved later, once any newly-absorbed content
  // (below) is merged in too.
  let fresh = await serializeAll(partEls);
  if (fresh.length === 0) { return; }

  const pageSize = await getPageSize(filePath, page);

  const existing = readUserData(iconEl);
  const base = existing?.kind === 'plug' ? existing.section : null;

  const bbox = contentBoundingBox(fresh, pageSize);
  if (!bbox) { return; }

  // The zone/absorb logic below needs to know the section's shape *before*
  // this redraw regardless of trigger — both as the growth basis for a
  // handle-triggered resize, and to isolate what a resize newly covered
  // (below) for either trigger.
  const oldZone: Rect | null = base ? sectionZone(base.iconRect, base.relativeRect) : null;
  if (trigger === 'handle' && !oldZone) {
    console.error(`${LOG} live redraw (handle): no persisted zone found for section=${id} — aborting`);
    return;
  }

  // Icon trigger: shiftDx/shiftDy intentionally ignored — a live redraw's
  // content must stay exactly where it is (only the zone reshapes to reach
  // a dragged icon), unlike Recollapse's icon-overlap-after-absorb case.
  // Handle trigger: the corner moves directly to wherever the
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

  // Grow preservedNums with whatever's newly caught under the
  // stretched zone — but only content that overlaps the NEW zone and did
  // NOT already overlap the OLD zone (the section's shape just before this
  // redraw). Checking the new zone alone can't tell "covered
  // because the zone just grew" (REQ-230, must protect) apart from
  // "already sitting here for some other reason, e.g. drawn after Expand"
  // (REQ-200, must stay absorbable) — both look identical under that check.
  // Comparing against the old zone is what actually isolates the delta the
  // resize itself caused.
  const priorPreserved = new Set<number>(base?.preservedNums ?? []);
  const newlyCovered: number[] = [];
  // Content already inside the zone before this resize (e.g. drawn
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

  // Content-containment clamping in stretchZoneToIcon can leave the icon
  // overlapping the zone. Project it to just outside the zone's nearest edge.
  const projectedIcon = projectIconOutsideZone(iconRect, zone, ZONE_MARGIN);
  const iconR: Rect = {
    left: Math.round(projectedIcon.left),
    top: Math.round(projectedIcon.top),
    right: Math.round(projectedIcon.right),
    bottom: Math.round(projectedIcon.bottom),
  };
  // Write back unconditionally, not just when projection actually moved
  // it — expandOne's own re-read of the icon's page position is what
  // places the rebuilt zone, so a finger-synthesized position (never
  // written to the page by anything else) has to be committed here.
  if (iconEl?.textBox) {
    iconEl.textBox.textRect = iconR;
  }
  const temp: CollapseSection = {
    schemaVersion: base?.schemaVersion ?? SCHEMA_VERSION,
    id,
    iconRect: iconR,
    relativeRect: relativeRectFor(iconR, zone),
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

  // REQ-340: re-verify we're still on the page captured at entry before the
  // point of no return — a page-turn mid-operation (e.g. a finger drag also
  // read as a native swipe) would leave every write below targeting the old
  // page while the note has moved on. Abort before deleting anything: the
  // section is left exactly as it was.
  const pageNow = await getCurrentPageNumOrNull();
  if (pageNow !== page) {
    console.error(`${LOG} live redraw: page changed mid-operation (was ${page}, now ${pageNow}) — aborting before delete`);
    return;
  }

  // The name (if any) rigidly follows the icon's own drag delta — the only
  // way it ever moves programmatically. Done only now, past every early exit,
  // so an abort above never leaves a moved copy next to the old name. The icon doesn't move under a
  // handle-triggered resize, so the name doesn't either.
  if (trigger === 'icon' && nameEls.length > 0) {
    // From the icon's final (possibly projected) position, not the raw drop
    // point — the name keeps its place relative to where the icon ends up.
    const nameDx = iconR.left - entry.iconRect.left;
    const nameDy = iconR.top - entry.iconRect.top;
    const serializedName = await serializeAll(nameEls);
    // Safe two-point EMR delta — convert the "from" (last-drawn) and "to"
    // (current) icon points independently, then subtract. See
    // rebuildNameElements's doc comment for why converting a bare delta
    // directly would be wrong.
    const nameEmrFrom = PointUtils.androidPoint2Emr({ x: entry.iconRect.left, y: entry.iconRect.top }, pageSize);
    const nameEmrTo = PointUtils.androidPoint2Emr({ x: iconR.left, y: iconR.top }, pageSize);
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
      recycleAll(nameInsertBatch);
    }
  }

  // Delete the old content + fill + outline, then re-expand in place. The temp
  // section is anchored to the CURRENT icon (emrDelta=0 ⇒ content rebuilds where
  // it is); relativeRect places the mask at the stretched zone. If the delete
  // didn't fully land, re-inserting would put a second copy next to whatever
  // is left — fall back to collapsed instead (the next Expand clears any
  // tagged leftovers before inserting).
  if (removeNums.length > 0) {
    const { ok: deleteOk, remaining, unstableNote } = await deleteElementsVerified(filePath, page, removeNums);
    if (!deleteOk) {
      console.error(`${LOG} live redraw: ${remaining.length} element(s) never removed: ${JSON.stringify(remaining)} — falling back to collapsed`);
      await fallBackToCollapsed(filePath, page, iconEl, temp);
      if (!unstableNote) await alertOverBusyView('live redraw', "Supernote couldn't redraw this section, so it was collapsed instead — please expand it again.");
      return;
    }
  }

  // Without this flush, insertElements right after the delete can silently
  // no-op (reports success, nothing lands) in this redraw sequence.
  await PluginNoteAPI.saveCurrentNote();

  // Pass `all` (already fetched above) so expandOne can clean up any
  // stale leftovers from a prior failed attempt without a second fetch.
  const reinsertOk = await expandOne(temp, iconEl, filePath, page, false, all); // capturePreserved defaults false
  if (!reinsertOk) {
    // expandOne already alerted and reverted the icon to `temp`'s own
    // state on failure — but `temp` has isExpanded:true with the content
    // only in its userData backup, since the old on-page parts were already
    // deleted above. isExpanded:true would route the next tap to a
    // Recollapse that finds nothing on the page and aborts.
    await fallBackToCollapsed(filePath, page, iconEl, temp);
    return;
  }
  // Unlike every other call site, the flush above leaves this path's
  // on-screen render stale, so it needs an explicit reload.
  await reloadFileWithTimeout();
  dlog(`${LOG} live full redraw section=${id} icon=[${iconR.left},${iconR.top}] zone=[${Math.round(zone.left)},${Math.round(zone.top)},${Math.round(zone.right)},${Math.round(zone.bottom)}]`);
}

// A clean collapsed state, with the content taken from the stashed `temp`
// backup — a real, working "undo" of the redraw, not a data loss.
async function fallBackToCollapsed(filePath: string, page: number, iconEl: any, temp: CollapseSection): Promise<void> {
  if (iconEl?.textBox) iconEl.textBox.textContentFull = ICON_GLYPH;
  const { ok } = await writeSection(filePath, page, iconEl, { ...temp, isExpanded: false }, iconEl);
  if (!ok) console.error(`${LOG} live redraw: failed to fall back to collapsed — section may be left inconsistent`);
  forgetSection(temp.id);
}
