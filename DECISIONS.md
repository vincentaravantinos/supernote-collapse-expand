# Architectural Decisions

A log of significant, non-obvious design choices and the alternatives that were
rejected. This is the *why* behind the architecture — distinct from CHANGES.md
(*what* changed) and SDK_DOC.md (*what the SDK does*).

Add an entry only when a decision was significant: the architect phase weighed
and rejected an alternative, or a diagnostic uncovered a fundamental SDK
constraint that forced the design. Routine fixes don't belong here. See
AGENT.md → "Steps independent of workflow" for the trigger.

Each entry should capture:
- **Date** and a short title
- **Decision** — what we chose
- **Alternatives considered** — and why they lost
- **Constraint** — any SDK / firmware / spec limitation that forced it

---

## 2026-06-12 — Tap-to-toggle: per-page icon cache instead of a read on every tap

**Decision.** A single finger tap on a "+" icon toggles its section
(expand/recollapse). To hit-test a tap's coordinates against icon rects
without an SDK call on every touch, the plugin keeps an in-memory cache of all
section icons on the *current* page (`iconPageCache`), built with one
`getElements` on the first qualifying tap and reused for free afterwards. The
cache is invalidated after any of the plugin's own mutations (button-driven
collapse/expand/recollapse, and the icon-drag live redraw), since those can
move/add/remove icons on the page.

**Alternatives considered.**
- *Call `getCurrentPageNum()` + `getElements()` on every qualifying tap.*
  Rejected: would add a full-page read to every single-finger tap, including
  ones nowhere near an icon — unacceptably slow on dense pages (see BACKLOG #5
  perf floor).
- *Maintain the cache proactively, refreshed on a page-change event.* Not
  available: no page-navigation/focus event exists in the SDK (confirmed via
  `.d.ts` + SDK_DOC.md), so the cache can only be validated reactively (compare
  `getCurrentPageNum()` against the cached page on each tap) and rebuilt
  lazily.
- *Gate tap-to-toggle on `toolType` only, reacting to pen taps too.* Rejected
  after an on-device probe: a pen tap draws an ink dot (expected SDK
  behaviour), so reacting to it would fight the user's drawing. Finger taps
  (`toolType === 1`) have no host-level side effect, so only those toggle.

**Constraint.** No SDK event fires on page navigation or on a plain tap/selection
(only `PEN_UP` for drawing and the raw `MOTION_EVENT` stream) — this and the
per-write file-rewrite cost (BACKLOG #5) jointly rule out any "always know all
icon rects" design that doesn't lazily rebuild per page.

## 2026-07-12 — Naming a section: stateless icon+ink trigger, not a pending offer

**Decision.** A section is named/renamed by lassoing its collapsed icon
**together with** freshly-written, untagged ink and pressing the plugin
button — the same "infer the action from what's selected" pattern already
used for Collapse/Expand/Recollapse. A blocking confirm dialog
(`NativeUIUtils.showRattaDialog`) gates the mutation; declining falls through
to a normal Expand with the ink left untouched. This makes naming fully
stateless: available any time a section is collapsed, not just right after
its own Collapse.

**Alternatives considered.**
- *Two-phase "pending offer" flow* (Collapse now, then a following press
  supplies bare ink as the name for whichever section was just collapsed,
  optionally with a timeout). Rejected: the identical gesture (lasso bare
  ink, press) would be ambiguous between "name the section I just collapsed"
  and "collapse this new, unrelated content" — disambiguated only by
  invisible in-memory state the user has no way to see. A sloppy or
  back-to-back workflow (collapse A, immediately try to collapse B) would
  silently misfire.
- *No confirm dialog, just fire on icon+ink.* Rejected: Expand's existing
  trigger already permits "icon lassoed together with other content" (that
  content is simply left in place). Silently reinterpreting that same
  combination as a destructive rename risked consuming unrelated handwriting
  that only happened to share a sloppy lasso with a collapsed icon. The
  confirm dialog makes the destructive step opt-in regardless of how the
  selection happened, and doubles as the safety net for overwriting an
  existing name.

**Constraint.** The SDK's toolbar button is singular and its action is only
ever inferred from the current selection (no per-operation buttons, no
selection-changed event to relabel it — see BACKLOG #2) — any new operation
has to fit into that same "what's in the lasso" dispatch, not a separate UI
surface.

## 2026-07-12 — A section's name keeps tracking an expanded-icon move live

**Decision.** Keep the name's existing live-drag behavior: while a section is
expanded, dragging its icon translates the name in the same per-drag-release
pass that already redraws the mask/frame (`iconMoveRedraw.ts`), preserving
the name's original offset to the icon exactly.

**Alternatives considered.**
- *Defer the name's catch-up to the section's next Recollapse instead of
  live* (matching how a *collapsed* icon move is only reconciled at the next
  Expand, since that case has no live event to hook at all). Fully
  implemented and then reverted: it required a second persisted anchor field
  (`nameAnchorRect`, separate from `iconRect`, since `iconRect` itself is
  kept continuously live-synced during an expanded drag for the mask/frame
  — reusing it as the name's "last reconciled" reference always read as "no
  movement"). Once built, it turned out to solve a problem that didn't need
  solving: unlike the collapsed case, an expanded-icon move already *has* a
  live listener doing the equivalent work for the mask/frame, and the
  original live-tracking implementation (from when Name/Rename first
  shipped) was already correct. Deferring added a schema field and a new
  reconciliation path in `recollapseAction.ts` for no behavioral benefit
  over what already worked.

**Constraint.** None — this reverses a decision made without checking
whether the "not live, too hard" premise still held once the icon actually
had a live listener already in place for the expanded case.

## 2026-06-12 — Durability invariant: write-before-delete ordering (crash safety)

**Decision.** Every operation that moves a section's content between its two
durable forms — icon `userData` (collapsed) and on-page `CE_PART`/mask elements
(expanded) — must create and confirm the new copy *before* removing the old one.
Concretely: collapse inserts the icon (carrying the serialized content) before
deleting the originals; recollapse writes the icon's `userData` before deleting
the on-page parts/masks; the live icon-move redraw stashes freshly-serialized
content into `userData` before deleting the old parts to rebuild them. On a
write/insert failure, the delete is skipped entirely and the old copy is left in
place. This guarantees that at every instant, content exists in at least one
durable place — never only in JS memory with both durable copies gone — closing
the crash windows that could previously lose a section.

**Alternatives considered.**
- *A journal/transaction log recording in-flight operations, replayed on next
  launch to detect and recover an interrupted op.* Rejected: would need a
  sidecar file, which conflicts with keeping the plugin's state fully
  self-contained in the `.note` (userData only); and replay/recovery logic is
  far more complex than just reordering existing calls so no recovery is ever
  needed.
- *Some form of multi-call transaction/batch API.* Not available — the SDK's
  `insertElements`/`deleteElements`/`modifyElements` are independent host-side
  writes with no atomicity across calls, so ordering is the only lever we have.
- *Leave the busy-guard reliant solely on the existing `setTimeout` watchdog.*
  Rejected: JS timers don't fire while the host is idle/dead, so a guard left
  `busy` by a crash would wedge the action button until the plugin process
  restarts. The guard now tracks an acquisition timestamp and self-heals after a
  stale threshold (~90s), independent of any timer.

**Constraint.** `insertElements`, `deleteElements`, and `modifyElements` are
independent, non-transactional host writes, and the host process itself can be
killed between any two of them (observed: native `std::out_of_range` abort on a
corrupted page). The write-before-delete ordering is the only mechanism available
to guarantee no-loss across such a crash.

## 2026-06-11 — Read the section's own elements, not the whole page (perf)

**Decision.** Expand and recollapse no longer call the full `getElements` on a
dense page. Expand uses `getElementNumList` (for `preservedNums`, which only needs
the num set) plus a single `getElement` for the icon. Recollapse, when the section
was expanded **this session**, fetches the icon (by a num cached in the in-memory
expanded-registry) plus only the "not preserved at expand" nums (its parts/masks/
frame + any new strokes) via per-num `getElement`. Both fall back to the full
`getElements` when they can't (registry empty after a restart, stale icon num,
candidate count over a cap, or multi-section recollapse). `writeSection` also
takes the already-fetched icon instead of re-reading the page.

**Alternatives considered.**
- *Keep the full `getElements`.* Rejected: measured ~3.2–4.2s on a ~230-element
  page — it marshals every element across the JS bridge, while we need only a few.
- *Per-element `getElement` for everything (incl. recollapse always).* Rejected
  for the after-restart / multi-section / huge-candidate cases: `getElement` is
  cheap (~28ms) but the full read amortizes better once you need many elements, so
  a cap + fallback guards the pathological cases.
- *Native module bypassing the JS bridge.* Deferred (backlog): biggest potential
  win but a large, separate effort.

**Constraint.** Measured SDK costs on a ~230-element page: `getElements` ~3.5s,
`getElementNumList` ~0.5s, `getElement` ~28ms each; and — unaddressed here — each
**write** (`insertElements` / `modifyElements` / `deleteElements` /
`saveCurrentNote`) costs ~2–3s regardless of how few elements we touch, because
the SDK rewrites/reprocesses the whole page. That per-write cost is the remaining
floor (see backlog).

---

## 2026-06-11 — Busy indicator via the plugin's own view; live redraw must not use idle timers

**Decision.** Show a "working" indicator during slow operations by rendering the
plugin's **own React view** (`App.tsx`, a small centered card on a transparent
backdrop) with `PluginManager.showPluginView()` / `closePluginView()` — shown
after the selection is read, hidden in the `finally`. Wired into both the button
action (`handleMainAction`) and the live icon-move redraw (`redrawSectionBox`).

Separately, the live icon-move redraw now runs **directly on the motion UP
event**, not via a debounced `setTimeout`. Rapid drags are coalesced with the
shared busy guard plus a re-run flag.

**Alternatives considered.**
- *Native dialogs (`showRattaDialog`, `showErrorTipDialog`, `alert`).* Rejected:
  all are **blocking modals** — they'd freeze the very operation we want to report
  progress on. The SDK exposes no non-blocking busy/toast primitive. The plugin's
  own view (the sn-shapes pattern) is the only non-blocking UI surface.
- *Full-screen translucent backdrop.* Rejected: e-ink doesn't alpha-blend, so any
  tint renders solid white and blanks the whole canvas. The backdrop is
  transparent; only the small card draws.
- *Keep the 600 ms `setTimeout` debounce for the redraw.* Rejected after a
  heartbeat probe (a `setInterval` logging every 2 s) proved the JS event loop is
  **not pumped while the plugin is idle** — the heartbeat fired only while an
  operation's `await` chain was running, and was silent at rest. So a deferred
  timer never fires after the pen lifts; the redraw must be kicked from the
  (pumped) motion event itself.
- *Tight icon-grab gate (8 px pad).* Rejected: the 50 px icon is a small target and
  edge-grabs landed just outside, so the gate missed real moves. Widened to 30 px;
  this is safe now because `redrawSectionBox` reads-before-dismiss (only commits
  `setLassoBoxState(2)` when the icon actually moved), so a too-eager gate hit on a
  lasso-select is harmless.

**Constraint.** The plugin host (a) offers no non-blocking native UI and (b) does
not tick the JS event loop while idle — timer callbacks flush only when a native
event or an in-flight `await` ticks the runtime. Both shape the design above.

---

## 2026-06-11 — Absorb new strokes on recollapse via getElements geometry (no lasso)

**Decision.** Recollapse absorbs elements the user drew on top of an expanded
section (so they collapse with it) using on-page geometry, not `lassoElements`.
At the real expand, `preservedNums` = the nums of **all untagged elements** on
the page (cheap — just numbers, no point-draining). At recollapse, an untagged
element whose num is not in `preservedNums` is "new"; we serialize only those few
candidates and absorb the ones whose bbox overlaps the section area
(stroke/text/geometry). `preservedNums` is carried across live redraws and
cleared on recollapse.

**Alternatives considered.**
- *The original `lassoElements(contentRect)` read.* Rejected: it fed the note-side
  trail-cache desync (not fixed by `reloadFile`) — the reason absorb was disabled.
- *`preservedNums` = only untagged elements inside the section area at expand.*
  Rejected: needs geometry (and stroke-point draining) at expand. Storing all
  untagged nums is just numbers, lets the recollapse num-check skip pre-existing
  content without draining, and only the few genuinely-new candidates get a bbox.

**Constraint.** No SDK spatial query exists (`getElements` family takes no rect;
only the lasso selects by region). So region membership is computed by us — kept
cheap by the `preservedNums` pre-filter. Relies on `numInPage` not being reused
between expand and recollapse (monotonic in practice).

---

## 2026-06-11 — Live box redraw on icon drag: motion listener + in-memory gate; full redraw (fill + strokes)

**Decision.** While a section is expanded, dragging its icon redraws the **whole
section** live (on `ACTION_UP`) — white fill, outline, and strokes — at the new
stretched area, via a `registerMotionListener`. A module-level registry of
expanded sections (`expandedRegistry.ts`: `id → { iconRect, contentBBox }`,
populated on expand, cleared on recollapse) gates the work: on `ACTION_DOWN` an
in-memory point-in-rect test (icon rect + small touch-slop pad) decides if a
gesture grabbed an icon; only then, on `UP`, do we engage. The redraw
re-serializes the on-page strokes, deletes the section's content + fill +
outline, and re-expands in place via `expandOne` (reusing the tested mask/content
z-order and stroke-link handling) in a single `reloadFile`. A shared busy guard
(`busy.ts`) keeps it from racing the button handler.

**Distinguishing select from move (the hard part).** Selecting the icon is itself
a drag (lasso) and can start on or near the icon, so neither the gate nor a
finger-distance check can reliably tell a select from a move — both move the
finger and can start on the icon. The only true signal is whether the icon
*moved*, and a lifted drag-move is committed (made visible to `getElements`) by
`setLassoBoxState(2)` — which also cancels the user's selection. Resolution, in
order, each found by on-device pressure-testing:
- **Tap vs drag:** finger movement < ~16px → tap, skip entirely (never touch the
  selection).
- **Read before dismiss:** `saveCurrentNote` → `getElements` → check `moved`
  FIRST; only `setLassoBoxState(2)` if the icon actually moved. So a select
  (moved=false) is never dismissed. (`saveCurrentNote` alone surfaces a real move
  to `getElements` — verified; an earlier build dismissed-then-read and clobbered
  selects.)
- **Debounce ~600ms:** schedule the redraw and reset on any further touch, so the
  slow redraw never runs mid-gesture (which had been clobbering the next
  selection); a busy hit reschedules rather than drops.
- **Small gate pad:** keep it to touch slop so a lasso-select starting clearly
  outside the icon doesn't engage at all.
Residual: a near-icon select still spends a `saveCurrentNote`+`getElements` to
find `moved=false` (harmless), and rare misses are at device-noise level.

**Full redraw, cost accepted.** Re-filling the white mask requires the strokes
above it, and the SDK only inserts on top — so correct z-order means rebuilding
the strokes each drag (≈ an `expand` cost per drag; worse for stroke-link
sections via `rebuildStrokeLinks`' reloads). We first shipped an outline-only
variant to dodge this, but the PO judged the full redraw more natural and
accepted the latency since repositioning is rare (pairs with a "busy" indicator,
backlog item). The outline is still its own `CE_FRAME` element (kept distinct for
clarity / possible future outline-only paths), but the live redraw rebuilds
everything.

**Alternatives considered.**
- *Outline-only (ship on `main` first).* Cheaper and snappy, but leaves the
  stretched arm un-whited-out until recollapse; superseded by the full redraw.
- *Truly live during the drag (per `ACTION_MOVE`).* Rejected: redrawing per
  motion tick (≈0.5–1s each) is infeasible.
- *`PEN_UP` instead of motion.* Rejected: doesn't fire on a selection-move, only
  on drawing — confirmed by probe.
- *Recollapse then expand (two ops).* Rejected: two `reloadFile`s with a visible
  collapsed flash; reusing `expandOne` after an in-line delete does it in one.
- *Drop the DOWN gate, check on every UP.* Rejected: that's a `getElements` on
  every touch-up while expanded; the DOWN gate keeps SDK calls to real grabs.

**Constraint.** The motion payload has no element identity (coordinates only), so
the position↔element correlation (registry + DOWN gate) is unavoidable. See
SDK_DOC.md (Plugin event listeners).

---

## 2026-06-11 — Moving the icon while expanded reshapes the zone (supersedes 8ba0584's behavior)

**Decision.** When the icon is moved while a section is expanded, recollapse
**re-anchors the section to the icon's current physical position** and sets the
zone to the content bbox + margin **stretched to touch the icon's near edge**
(per-axis). On re-expand the content stays put and the zone reaches the icon, so
the icon's position relative to the area is preserved (drag bottom-right ⇒ icon at
the area's bottom-right; drag far ⇒ big mostly-empty area). The zone stops at the
icon's near edge so the expand-time mask (which renders over the older icon
element) never covers the icon. Move-icon-*while-collapsed* still relocates the
whole section via expand's `emrDelta`.

**This deliberately supersedes commit 8ba0584** ("moving the icon while expanded
no longer shifts strokes on re-expand"), which kept the *expand-time* anchor so
the section translated to follow the icon. The new behavior is the opposite
(content stays, zone stretches) — the PO wants moving the icon while expanded to
reshape the area, not move the section.

**Why it doesn't reintroduce 8ba0584's bug.** That bug was a *mismatch*:
`iconRect` was set to the post-move physical rect while `relativeRect` was still
computed against the old anchor, so strokes drifted from the mask. Here both
`iconRect` and `relativeRect` are derived from the *same* current icon rect, so
strokes and mask stay aligned (`emrDelta = 0` on re-expand when the icon hasn't
moved since).

**Alternatives considered.**
- *Shift the icon to stay just outside the zone (former backlog "Part 2").*
  Rejected/obsoleted: stretching the *zone* to the icon achieves the same
  icon↔zone adjacency without ever moving the icon (which had no proven SDK
  mechanism and would override manual icon moves).

---

## 2026-06-10 — Section zone defined by content bounding box, not the lasso; icon-shift staged

**Decision.** A section's zone (mask fill + boundary outline, via `relativeRect`)
is the bounding box of its **content** + a small margin (`ZONE_MARGIN`), computed
identically at the initial collapse and at every recollapse — not the user's
lasso rect. This makes the zone hug the strokes and adapt when content is moved
while expanded. The icon is placed up-left of that zone at collapse; at recollapse
the icon stays put (existing anchor preserved) and only `relativeRect` is
recomputed (`relativeRect = (contentBBox + margin) − iconRect`).

**Alternatives considered.**
- *Keep using the lasso rect (status quo) and only recompute at recollapse.*
  Rejected: the PO wanted the zone based on the strokes even at the first
  collapse, so a loose lasso doesn't leave a big empty frame.
- *Tight bbox with no margin.* Rejected: a small uniform margin reads better
  (strokes don't touch the frame).
- *Also shift the `+` icon up-left when the zone stretches left/up past it (so the
  icon is always just outside the zone).* **Staged to a backlog follow-up**, not
  dropped: it requires physically moving the icon element (no proven mechanism —
  `modifyElements` doesn't apply a picture's rect, untested for text; likely
  delete + re-insert) and it would override a manual icon move made while
  expanded, changing a tested anchor behaviour. Splitting keeps Part 1 low-risk.

**Constraint.** Computing the bbox unifies coordinate spaces: strokes are stored
in EMR (with their own maxX/maxY) and converted to android via
`emrPoint2Android`, while text/link/geometry are already android. The recollapse
recompute stays consistent with the icon-move `emrDelta` math because it keeps the
same anchor and the same `relativeRect = zone − iconRect` definition collapse uses.

---

## 2026-06-10 — Expand multiple sections in one press, batched into a single refresh

**Decision.** A press expands every collapsed section icon in the lasso (not just
the first), leaving any loose strokes in place; recollapse keeps priority over
expand. Like recollapse, this is batched — `expandAction` was split into
`expandOne` (per-section mutation, no save/lasso/reload) and `expandSections`
(flush + dismiss-lasso once, expand each, `reloadFile` once) — so N sections cost
one refresh.

**Alternatives considered.**
- *One refresh per section (loop the existing expand).* Rejected by the PO in
  favor of a single refresh, consistent with the recollapse-all decision.
- *Options that conflicted with "expand + leave loose strokes":* a "collapse the
  loose strokes while keeping the existing section" rule was rejected because it
  is the exact opposite action for the same selection (collapsed icon + loose
  strokes) — one button can't do both, and expand-wins matches existing behavior.

**Constraint.** Batching expand is only safe with stroke-link sections because
member-num recovery filters by the **section-specific `CE_PART:<id>` tag**: a
mid-batch `reloadFile` (forced by stroke-link num recovery) surfaces a prior
section's content, but that content carries a different id, so it is never
miscounted as the current section's members. A stroke-link section still adds its
own internal reloads (the real↔cached split requires a reload to read re-inserted
nums — see SDK_DOC.md).

---

## 2026-06-10 — Recollapse by section content: recollapse-priority + recollapse all spanned, batched into one refresh

**Decision.** Recollapse can be triggered by lassoing any element bearing a
section id (restored `CE_PART` content **or** the `CE_MASK`), not just the icon.
A single press recollapses **every** expanded section the selection spans, and
**recollapse takes priority**: if the lasso mixes an expanded section with a
collapsed icon, the expanded one(s) recollapse and the collapse/expand is ignored
that press. The N sections are mutated against one `getElements` snapshot and
surfaced with a single `setLassoBoxState(2)` + `reloadFile`, so N sections cost
one refresh.

**Alternatives considered.**
- *Trigger on restored content only (not the mask).* Rejected: the mask sits on
  top of the section and is often what the lasso actually grabs (especially over
  an empty patch), so excluding it would make the trigger miss obvious cases.
- *Recollapse only the first spanned section.* Rejected by the PO in favor of
  recollapsing all spanned sections.
- *Reuse the existing per-section `recollapseAction` in a loop.* Rejected: each
  call ended with its own `reloadFile`, giving one screen refresh per section.
  Split into `recollapseOne` (pure per-section mutation) + `recollapseSections`
  (flush/read once, mutate all, refresh once).
- *Mixed multi-operation in one press* (e.g. expand a collapsed section AND
  recollapse an expanded one): out of scope — deferred to the multi-section
  backlog item; recollapse-priority keeps the current press unambiguous.

**Constraint.** Sharing one pre-mutation `getElements` snapshot across the loop
is only safe because sections don't overlap and `deleteElements` doesn't renumber
other elements, so one section's deletions don't invalidate another's page nums.
The single-refresh batching relies on the real↔cached model (writes hit the real
file; one `reloadFile` at the end syncs cached:=real) — see SDK_DOC.md.

---

## 2026-06-10 — Stroke-link round-trip: store member indexes, recover new nums via reload+getElements, accept device-owned area

**Decision.** To round-trip a handwritten stroke link (`Link.category = 1`)
through collapse/expand:
1. Persist *which strokes* are the link's members as **indexes into the
   section's serialized element array**, not as page numbers.
2. On expand, re-insert the members, then learn their **new** page numbers by
   re-reading the page after a `reloadFile`, and rebuild the link with those as
   `controlTrailNums`.
3. Pass only a non-empty placeholder rect for the link and **accept the area the
   device computes** from the strokes.
4. Drive the expand inserts in batches so the member-num recovery costs **one
   reload per link** (bundle the mask with the first link's members; defer other
   content + the rebuilt links to a final batch the end-of-expand reload
   surfaces).

**Alternatives considered.**
- *Store raw `controlTrailNums` (page nums).* Rejected: page nums are not stable
  across a collapse/expand round-trip — re-inserted strokes get fresh nums.
- *Embed copies of the member strokes inside the link payload.* Rejected:
  duplicates data already in `collapsedElements` and bloats the userData budget.
- *Map old→new nums by insert order or element uuid.* Rejected: the PO confirmed
  neither reliably identifies which new num is which stroke. We don't need
  per-stroke identity anyway — `controlTrailNums` is a *set*, so the union of
  "stroke nums that newly appeared after inserting this link's members" suffices.
- *Supply the link's original area rect / a strokes-derived rect / omit it.*
  Rejected/forced: omitting it fails (error 509, "Invalid link area"); supplying
  it is futile because the device recomputes a category-1 link's area from
  `controlTrailNums` and ignores ours. So we can't reproduce the wider area an
  interactively-drawn link reserves for its auto-icon — reported to Ratta.
- *Keep the simple "insert main batch, then members with a separate baseline
  reload" flow (3 refreshes).* Rejected in favor of the batched 1-reload-per-link
  flow (2 refreshes for the common single-link case); the only cost is a subtle
  z-order shift for sections that mix a stroke link with other overlapping
  content, which the PO accepted.

**Constraint.** The SDK's real↔cached file split: `insertElements` writes the
real file but `getElements`/`getElementNumList` read the cached copy, which only
reflects the write after a `reloadFile` — so recovering re-inserted nums
inherently requires a reload between insert and read. And `insertElements`
recomputes a stroke link's area from its control strokes regardless of the rect
passed. Both documented in SDK_DOC.md.

---

<!-- Newest entries first. Template:

## YYYY-MM-DD — <short title>

**Decision.** <what we chose>

**Alternatives considered.** <options weighed, and why they were rejected>

**Constraint.** <the SDK / firmware / spec limitation that forced this, if any>

-->
