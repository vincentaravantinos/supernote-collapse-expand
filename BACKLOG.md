# Backlog

Open feature requests and deferred items. Worked per the workflows in
`AGENT.md` (features → architect-challenge then implementation; the
geometry item below is a bugfix-workflow item). Remove an item once the
user confirms it's done.

1. FEATURE: support **nested sections** — collapsing a region that contains another section's icon (and recollapsing/expanding correctly when sections are nested or overlap). Currently a non-goal (SPEC: "Sections do not nest or overlap"); this item is to lift that restriction.
2. FEATURE (BLOCKED — needs SDK change): make the **menu button label reflect the action that will occur** for the current selection — e.g. "Collapse" / "Expand" / "Recollapse" — instead of the single static "Collapse / Expand" label. Probed 2026-06-11 and found not feasible with the current SDK: re-registering the button only relabels the *next* toolbar (not the one already open), and there is no selection-made / menu-opening event to update before the toolbar renders (see SDK_DOC.md → "Toolbar button labels are fixed for the open toolbar"). Feedback filed in FEEDBACK.md. Revisit if Ratta adds a label-update or selection-changed API.
3. FEATURE: have different kinds of collapsed sections, ex. "Footnote", "Remark", "Justification"
4. FEATURE: give the user the possibility to change the text (+) to something of their choice. Some parametrization option.
5. PERF (needs SDK change or native module): on pages dense with handwriting, operations are still several seconds — the read-path cost was optimized (2026-06-11) but the floor is the SDK's per-write file cost (insertElements / modifyElements / deleteElements / saveCurrentNote each rewrite/reprocess the whole page, ~2-3s each regardless of how few elements we touch). Cutting this needs fewer mutation calls (e.g. batching insert+modify, if the SDK allows) or moving the element I/O to a native module that bypasses the JS bridge. Out of scope for v1.
6. FEATURE: add a menu entry "Flatten" that removes the section, but keeps the content, basically if the user doesn't want a section at all anymore but just wants to use the content directly
7. ISSUE: when a section is resized by moving the icon but goes past some existing strokes, then the section rectangle does not cover those strokes anymore, that's not right. Instead the section rectangle should be computed so that it still contains all strokes. That should be an invariant.
8. FEATURE: add an context menu to *name* the sections: it opens a pop up that lets the use provide a name for the section (typed, not hand written). That name should then be displayed next to the (+) text box (in the same text box)
