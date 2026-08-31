# Backlog

Open feature requests and deferred items. Worked per the workflows in
`AGENT.md` (features → architect-challenge then implementation). Remove
an item once the user confirms it's done.

1. FEATURE: support **nested sections** — collapsing a region that contains another section's icon (and recollapsing/expanding correctly when sections are nested or overlap). Currently a non-goal (SPEC: "Sections do not nest or overlap"); this item is to lift that restriction.
2. FEATURE (BLOCKED — needs SDK change): make the **menu button label reflect the action that will occur** for the current selection — e.g. "Collapse" / "Expand" / "Recollapse" — instead of the single static "Collapse / Expand" label. Probed 2026-06-11 and found not feasible with the current SDK: re-registering the button only relabels the *next* toolbar (not the one already open), and there is no selection-made / menu-opening event to update before the toolbar renders (see SDK_DOC.md → "Toolbar button labels are fixed for the open toolbar"). Feedback filed in FEEDBACK.md. Revisit if Ratta adds a label-update or selection-changed API.
3. PERF (needs SDK change or native module): on pages dense with handwriting, operations are still several seconds — the read-path cost was optimized (2026-06-11) but the floor is the SDK's per-write file cost (insertElements / modifyElements / deleteElements / saveCurrentNote each rewrite/reprocess the whole page, ~2-3s each regardless of how few elements we touch). Cutting this needs fewer mutation calls (e.g. batching insert+modify, if the SDK allows) or moving the element I/O to a native module that bypasses the JS bridge. Out of scope for v1.
   - Concrete lever, not yet explored: several operations issue **multiple separate write calls** where one might do — e.g. Collapse does `insertElements` (icon) then `deleteElements` (originals); Recollapse does a userData write then `deleteElements` (parts/mask); the live icon-drag redraw does a stash write, `deleteElements`, then `insertElements` (3 calls). `PluginFileAPI.replaceElements(notePath, page, elements)` exists ("Replaces all elements on a page") and has never been tried here — if its cost is similar to the other per-write calls (SDK_DOC.md: "roughly fixed regardless of how many elements you pass"), collapsing a call *pair* into one `replaceElements` could cut real wall-clock time. Needs on-device investigation before adopting: confirm exact semantics (does the passed array have to be the *complete* new page state, mixing kept-existing + newly-built elements?), confirm its per-call cost profile, and re-derive the crash-safety ordering guarantees this codebase relies on (insert-before-delete) — a whole-page replace may not offer the same partial-failure recoverability as two separately-ordered calls.
4. FEATURE/RISK: handle copy-pasting sections — a section's whole identity (parts, mask, name, underline, live-redraw tracking) is associated purely by an `id` embedded in the icon's userData, generated once at Collapse. A native (non-plugin) copy-paste of a section's icon duplicates that `id` verbatim, producing two sections that silently share it. Concretely: expanding both copies tags their content with the same `CE_PART:<id>`, so recollapsing *either* one sweeps up both sets of content into a single recollapse (merging/misplacing/duplicating strokes); live-redraw tracking (keyed by the same `id` in an in-memory map) would also collide. Needs a fix — e.g. detect and regenerate a colliding `id` on next plugin interaction with the section. Not yet investigated on-device; raised as a code-review-level architectural risk, not yet reproduced.
## Open change requests

| ID     | Description | Status |
|--------|-------------|--------|
| CR-002 | Declare plugin permissions (FILE:READ/WRITE/DELETE) for the new permission system | Analyzed — high impact, escalate to Feature |
| CR-003 | Audit getElement/getElementNumList/deleteElements against the new 1-indexed convention | Analyzed — low impact, fast-track |
| CR-004 | Investigate batchUpdatePageElements to cut per-write round-trips (BACKLOG item #3) | Analyzed — high impact, escalate to Feature |
| CR-005 | Investigate registerPluginLifeListener as a possible fix for B-013 (reboot known limitation) | Analyzed — high impact, escalate to Feature |

## Closed change requests

| ID     | Description | Status |
|--------|-------------|--------|
| CR-001 | Upgrade sn-plugin-lib to latest (Chauvet 3.29.43/2.26.40 SDK release) | Done |

## Open bugs
| ID | Symptom |
|---|---|
| B-012 | Select existing text/strokes, move them, then immediately Collapse (no other action in between): the icon appears (content reported as collapsed) but the original strokes visually remain on the page. Suspected same class as a previously-seen issue — the move likely only lands in the cached copy, not the real file, by the time the plugin reads elements; reading before a `saveCurrentNote` flush would see the pre-move (stale) position/content. Not yet investigated — reported by the user, explicitly deferred. |
| B-014 | A stroke link's visual indicator was once seen not surviving Collapse/Expand (functionality — tap-to-navigate — still did). Parked — could not reproduce across several attempts with instrumentation in place. See `BUGS/B-014.md`. |

