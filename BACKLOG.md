# Backlog

Open feature requests and deferred items. Worked per the workflows in
`AGENT.md` (features → architect-challenge then implementation). Remove
an item once the user confirms it's done.

1. FEATURE: support **nested sections** — collapsing a region that contains another section's icon (and recollapsing/expanding correctly when sections are nested or overlap). Currently a non-goal (SPEC: "Sections do not nest or overlap"); this item is to lift that restriction.
2. FEATURE (BLOCKED — needs SDK change): make the **menu button label reflect the action that will occur** for the current selection — e.g. "Collapse" / "Expand" / "Recollapse" — instead of the single static "Collapse / Expand" label. Probed 2026-06-11 and found not feasible with the current SDK: re-registering the button only relabels the *next* toolbar (not the one already open), and there is no selection-made / menu-opening event to update before the toolbar renders (see SDK_DOC.md → "Toolbar button labels are fixed for the open toolbar"). Feedback filed in FEEDBACK.md. Revisit if Ratta adds a label-update or selection-changed API.
3. PERF (needs SDK change or native module): on pages dense with handwriting, operations are still several seconds — the read-path cost was optimized (2026-06-11) but the floor is the SDK's per-write file cost (insertElements / modifyElements / deleteElements / saveCurrentNote each rewrite/reprocess the whole page, ~2-3s each regardless of how few elements we touch). Cutting this needs fewer mutation calls (e.g. batching insert+modify, if the SDK allows) or moving the element I/O to a native module that bypasses the JS bridge. Out of scope for v1.

## Open bugs
| ID | Symptom |
|---|---|
| B-004 | Recollapse could leave the frame and/or some content strokes behind. Fix implemented (`r101-preservednums-fix-v2`), still under active testing — not yet confirmed. See `BUGS/B-004.md`. |

