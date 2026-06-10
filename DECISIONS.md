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
