# Backlog

Open feature requests and deferred items. Worked per the workflows in
`AGENT.md` (features → architect-challenge then implementation). Remove
an item once the user confirms it's done.

1. FEATURE: support **nested sections** — collapsing a region that contains another section's icon (and recollapsing/expanding correctly when sections are nested or overlap). Currently a non-goal (SPEC: "Sections do not nest or overlap"); this item is to lift that restriction.
2. FEATURE (BLOCKED — needs SDK change): make the **menu button label reflect the action that will occur** for the current selection — e.g. "Collapse" / "Expand" / "Recollapse" — instead of the single static "Collapse / Expand" label. Probed 2026-06-11 and found not feasible with the current SDK: re-registering the button only relabels the *next* toolbar (not the one already open), and there is no selection-made / menu-opening event to update before the toolbar renders (see SDK_DOC.md → "Toolbar button labels are fixed for the open toolbar"). Feedback filed in FEEDBACK.md. Revisit if Ratta adds a label-update or selection-changed API.
3. PERF (needs SDK change or native module): on pages dense with handwriting, operations are still several seconds — the read-path cost was optimized (2026-06-11) but the floor is the SDK's per-write file cost (insertElements / modifyElements / deleteElements / saveCurrentNote each rewrite/reprocess the whole page, ~2-3s each regardless of how few elements we touch). Cutting this needs fewer mutation calls (e.g. batching insert+modify, if the SDK allows) or moving the element I/O to a native module that bypasses the JS bridge. Out of scope for v1.
   - Concrete lever, tried and rejected (CR-004, 2026-09-17): several operations issue **multiple separate write calls** where one might do — e.g. Collapse does `insertElements` (icon) then `deleteElements` (originals); Recollapse does a userData write then `deleteElements` (parts/mask); the live icon-drag redraw does a stash write, `deleteElements`, then `insertElements` (3 calls). `PluginCommAPI.batchUpdatePageElements` (combined insert+delete in one call) was spiked on-device and rejected — its delete component silently does nothing even for a single valid target, while still reporting success (see DECISIONS.md, FEEDBACK.md). Not adopted.
   - Still unexplored: `PluginFileAPI.replaceElements(notePath, page, elements)` ("Replaces all elements on a page") — a different API from the one just rejected, never tried here. If its cost is similar to the other per-write calls (SDK_DOC.md: "roughly fixed regardless of how many elements you pass"), collapsing a call *pair* into one `replaceElements` could still cut real wall-clock time. Needs on-device investigation before adopting: confirm exact semantics (does the passed array have to be the *complete* new page state, mixing kept-existing + newly-built elements?), confirm its per-call cost profile and that its writes actually land (given what was just found with `batchUpdatePageElements`, don't trust a bare success flag), and re-derive the crash-safety ordering guarantees this codebase relies on (insert-before-delete) — a whole-page replace may not offer the same partial-failure recoverability as two separately-ordered calls.
4. FEATURE/RISK: copy-pasting a section's icon **while expanded** still risks a duplicated identity — an expanded section's parts/mask/frame/handle are all tagged with the same `id` as the icon, so a native copy-paste that duplicates the icon (with those still on the page) produces two sections sharing one `id`. Expanding/recollapsing/redrawing either one would then cross-contaminate the other (merged/misplaced/duplicated strokes; colliding live-redraw tracking). Copy-pasting a **collapsed** icon is already self-healed (CR-010, 2026-09-28) — this remaining item is scoped to the expanded case only, deliberately left unfixed there (see DECISIONS.md 2026-09-28): fixing it would mean retagging every CE_PART/MASK/FRAME/HANDLE element for one of the colliding sections, not just regenerating the icon's own id. Not yet investigated on-device; lower priority than the collapsed case, since copy-pasting a whole expanded section's visible area is a far less likely real-world action than copy-pasting a small collapsed icon.
## Open change requests

| ID     | Description | Status |
|--------|-------------|--------|
| CR-005 | Investigate registerPluginLifeListener as a possible fix for B-013 (reboot known limitation) | Analyzed — high impact, escalate to Feature |

## Closed change requests

| ID     | Description | Status |
|--------|-------------|--------|
| CR-001 | Upgrade sn-plugin-lib to latest (Chauvet 3.29.43/2.26.40 SDK release) | Done |
| CR-002 | Declare plugin permissions (FILE:READ/WRITE) for the new permission system | Done |
| CR-003 | Audit getElement/getElementNumList/deleteElements against the new 1-indexed convention | Done — no code change needed |
| CR-004 | Investigate batchUpdatePageElements to cut per-write round-trips (BACKLOG item #3) | Done — rejected, delete component doesn't work |
| CR-006 | Absorb pre-existing content dragged into an expanded section's zone (position-based, not just number-based, tracking) | Done — zone-scoped, incrementally-grown preservedNums; confirmed on-device |
| CR-007 | Content inside an expanded section must stay individually lasso-selectable (from B-021) | Done — mask/border rebuilt as STROKE instead of GEO_polygon; confirmed on-device |
| CR-008 | Bottom-right resize handle for expanded sections (was BACKLOG item 5) | Done — persisted `CE_HANDLE` element with its own resize geometry; confirmed on-device |
| CR-009 | Finger-drag support for icon/handle resize (was BACKLOG item 6) | Done — synthesizes position from the raw touch delta; confirmed on-device |
| CR-010 | Self-heal a duplicated section id, collapsed case (BACKLOG item 4) | Done — regenerates the colliding id via the existing icon-cache scan; confirmed on-device |
| CR-011 | Name confirmation dialog titled "Collapse / Expand" instead of the SDK's "Prompt" | Done — plugin-view dialog; confirmed on-device |
| CR-012 | Name a section while it's expanded (icon + loose strokes = name) | Done — plus underline refit and orphan cleanup; confirmed on-device |
| CR-013 | Menu button = secondary actions; run the only applicable action directly, ask when several apply | Done — confirmed on-device |

## Open bugs
| ID | Symptom |
|---|---|
| B-012 | Select existing text/strokes, move them, then immediately Collapse (no other action in between): the icon appears (content reported as collapsed) but the original strokes visually remain on the page. Suspected same class as a previously-seen issue — the move likely only lands in the cached copy, not the real file, by the time the plugin reads elements; reading before a `saveCurrentNote` flush would see the pre-move (stale) position/content. Not yet investigated — reported by the user, explicitly deferred. |
| B-014 | A stroke link's visual indicator was once seen not surviving Collapse/Expand (functionality — tap-to-navigate — still did). Parked — could not reproduce across several attempts with instrumentation in place. See `BUGS/B-014.md`. |
| B-019 | Dragging native/untracked content (esp. links) into an expanded section: one strand (Recollapse orphaning a dragged-in link) fixed and confirmed; the other (page -1 + app-wide corruption after icon-drag redraw) parked — not reproducible after extensive retesting. See `BUGS/B-019.md`. |
| B-025 | A live redraw left a second, collapsed (⊕) copy of an expanded section next to it. The trigger (a redraw running when the handle was only selected) is fixed; how a redraw can create the duplicate is parked, not reproducible. See `BUGS/B-025.md`. |
## Closed bugs
| ID | Symptom |
|---|---|
| B-026 | Naming showed "Couldn't set the section name" although it was set (stale verification read after a reloadFile timeout). Fixed — the check now re-reads up to 3 times; confirmed on-device. |
| B-015 | Permission gate (CR-002) silently let an operation proceed unpermitted — fixed by dropping the `hasPermission` pre-check and trusting only `requestPermission`'s documented result. See `BUGS/B-015.md`. |
| B-016 | External SDK bug: `userData` never survived a round trip on Chauvet 2.26.40/3.29.43 — fixed by Ratta in 3.29.44/2.26.41, confirmed on-device. See `BUGS/B-016.md`. |
| B-017 | `PluginCommAPI.reloadFile()` could hang indefinitely — removed from 5 of 6 call sites (confirmed unneeded on this SDK build), timeout-guarded at the 1 remaining one. See `BUGS/B-017.md`. |
| B-018 | Recollapse/Expand/icon-drag-redraw of a stroke-link section could partially complete or misfire. Five root causes fixed: `deleteElements`/`modifyElements` silently applying to only some targets or not at all; a `reloadFile`-then-read race; `writeSection`'s own verification checking the wrong field; `expandOne` not reverting cleanly on failure; and `insertElements` silently no-op'ing right after this codebase's own `deleteElements` in the icon-drag sequence (fixed with a `saveCurrentNote()` flush). Every failure alert being swallowed by the busy overlay was also fixed. See `BUGS/B-018.md`. |
| B-021 | Can't lasso individual content inside an expanded section — the mask/border, built as `GEO_polygon`, swept in any lasso drawn anywhere inside them. Fixed by rebuilding both as `STROKE` elements instead (CR-007); confirmed on-device. See `BUGS/B-021.md`. |
| B-020 | Content drawn after Expand could get wrongly protected from absorb (not folded into the section on Recollapse) once a resize happened in between — a gap in CR-006's incremental preservedNums growth. Fixed: compare against the zone's shape before the resize, and immediately absorb (not just protect-check) content already in the zone, fixing a visual disappearing side effect too. See `BUGS/B-020.md`. |
| B-022 | Dragging an expanded section's icon deep inside its own content could leave strokes outside the redrawn area, and could leave the icon hidden underneath the section. Fixed: the area's shift is now clamped to never exclude content, and the icon is repositioned to sit just outside it instead of ending up hidden. See `BUGS/B-022.md`. |
| B-023 | Expand's insert-verification counted stale leftovers from a prior failed attempt, letting a genuinely-failed insert pass and never cleaning up duplicates — the reason recovery after an alert took several rounds. Fixed: Expand now cleans up any leftovers from a prior attempt first. Verified via failure injection. See `BUGS/B-023.md`. |
| B-024 | Dragging the CR-008 resize handle with a finger showed the busy popup and ran a full redraw, but the area never actually resized. Not a bug: confirmed the pencil resizes correctly; the resize listener doesn't filter by input type and a finger touch doesn't relocate page elements on this device. Real finger-drag support added separately (CR-009). See `BUGS/B-024.md`. |

