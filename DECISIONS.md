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
