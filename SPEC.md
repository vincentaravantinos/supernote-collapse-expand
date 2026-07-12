# Collapse / Expand Plugin — Specification

This document captures the behaviour the plugin is required to provide.
Implementation details belong in the code; this file is the source of truth
for *what* the plugin does, not *how* it does it.

## Overview

The plugin lets a Supernote user hide a region of hand-written content
behind a small "+" icon ("collapse"), bring it back ("expand"), and put it
back behind the icon when they're done with it ("recollapse"). The user
keeps full control of the surrounding canvas while a region is collapsed.

## Core operations

The plugin exposes a **single button** ("Collapse / Expand") on the lasso
menu. Every operation below is triggered by pressing that same button; which
one happens is inferred entirely from what's currently lassoed. There is no
per-operation button.

### Collapse
**Trigger**: user lassoes some content on the page and presses the plugin
button.

**Outcome**:
- The lassoed content disappears from the page.
- A "+" icon appears just above-left of where the lasso was (offset by half
  an icon size, clamped at the page edge), so it stays clear of the restored
  content when the section is later expanded and remains easy to select.
- The icon carries enough state to reproduce the original content
  (positions, ink properties, layer, …) on a later expand.
- Pictures and titles in the lasso are left in place (not collapsable).

### Name / Rename (optional)
**Trigger**: user writes a name somewhere on the page in their own
handwriting, lassoes it **together with exactly one collapsed section's
icon** (no other icons, no restored/expanded content), and presses the
plugin button.

**Outcome**:
- A blocking confirmation dialog asks the user to confirm: "Set this
  section's name to the selected handwriting?" (or "Replace..." if the
  section already has a name).
  - **Confirmed**: the lassoed name strokes are moved from wherever they
    were written to a fixed position anchored to the icon (up-right of it,
    mirroring the icon's own placement relative to its content), and stay
    permanently visible next to the icon regardless of whether the section
    is collapsed or expanded. If a name already existed, its old strokes
    are deleted first.
  - **Declined**: nothing about the name changes; the press falls through
    to a normal Expand instead, with the name-candidate ink left in place
    untouched — i.e. exactly today's behaviour when unrelated content
    happens to share a lasso with a collapsed icon.
- Available any time a section is collapsed — not limited to right after
  its own Collapse. Naming an already-expanded section is out of scope for
  v1 (lasso the icon while it's still collapsed).
- If the lasso contains untagged ink alongside **more than one** collapsed
  icon, the target is ambiguous: no naming/confirmation is offered, and the
  press is treated as a normal multi-section Expand instead (ink left in
  place).
- The name strokes move together with the icon whenever the icon is
  repositioned — rigidly, by the icon's own movement delta. This is unlike
  restored *content*, which stays physically fixed while expanded (only the
  mask/outline stretch to reach a moved icon): the name has no anchored
  position of its own to stay fixed at, so it always follows the icon
  exactly, the same way the icon follows the user's drag.
  - **While expanded**, it's translated live on each drag-release.
  - **While collapsed**, there is no live tracking (the SDK gives no move
    event for a collapsed icon) — the name catches up at the section's
    **next Expand**, translated by the delta the icon moved since the
    section was last saved. Until then, the name stroke stays at its old
    position, visually detached from the icon.

### Expand
**Trigger**: user lassoes the "+" icon of one or more collapsed sections
(optionally together with other content) and presses the plugin button. As a
shortcut, a single **finger** tap directly on a collapsed section's icon also
expands it (a pen tap draws ink as normal and is ignored).

**Outcome**:
- The original content reappears at its location (translated if the icon
  was moved while collapsed).
- If multiple collapsed sections are selected, all of them expand in one
  press; any other selected content is left in place.
- A visual mask covers the section's area so any user content the user
  drew on top of (or under) the icon while collapsed is hidden behind the
  expanded section.
- Pre-existing user content sitting under the section's area must be
  remembered so it can be told apart from content the user adds *during*
  expansion (see Recollapse).

### Recollapse
**Trigger**: user lassoes the "+" icon **or any restored content / mask** of an
expanded section and presses the plugin button. If the selection spans multiple
expanded sections, all of them are recollapsed in one press. (Recollapse takes
priority: a selection that mixes an expanded section with a collapsed icon
recollapses the expanded one(s) and ignores the collapse/expand that press.) As
a shortcut, a single **finger** tap directly on an expanded section's icon also
recollapses it.

**Outcome**:
- The "+" icon stays where it is.
- All restored content disappears again.
- The mask is removed.
- Moving the icon **while collapsed** relocates the whole section (content
  follows the icon on the next expand). Moving the icon **while expanded**
  instead reshapes the section's area: on the next expand the restored content
  stays where it is and the zone stretches so the icon sits just at the area's
  edge (move the icon far and the section becomes a large, mostly-empty area).
  While expanded, the **whole section is redrawn live** on each drag-release —
  white fill, outline, and strokes — at the new stretched area, so the user sees
  the final result immediately. This rebuilds the strokes each time (to keep them
  above the fresh fill), so it is noticeably slower than a normal pan; it is
  intended for occasional repositioning, not continuous dragging.
- Any **new** strokes the user drew on top of the expanded section are
  absorbed into the section's saved state (so they reappear on the next
  expand).
- Any content that was sitting on the page **before** the expand and
  happened to be inside the section's area must remain at its original
  position, untouched by recollapse.

## Busy feedback

Operations on a large note (collapse / expand / recollapse, and the live
icon-move redraw) can take several seconds. While one is running the plugin
must show a non-blocking "working" indicator so the canvas doesn't look
frozen, and remove it when the operation finishes. The indicator must not
block the operation it reports on (so it cannot be a modal dialog) and must
leave the surrounding page visible (it is a small overlay, not a full-screen
cover).

## Persistence requirements

**Hard requirement.** Every operation must be robust against the user
turning the device off (or the app crashing, or the page being reloaded)
between operations. After power-on, the user must be able to perform any
valid next operation on any section without the plugin losing track of:

- which icons are sections,
- which sections are currently collapsed vs expanded,
- the original content of a collapsed section,
- the strokes that should be preserved across the next recollapse.

In practice this means **every piece of state the plugin relies on must
live on disk** in element `userData` (icon, parts, masks) or in the
element list itself. No state may live only in JS memory across a
collapse / expand / recollapse cycle.

If a new feature ever needs state that doesn't fit in a single element's
`userData`, that state must be serialised onto a stable, persisted
location (typically the section icon's `userData`) before the operation
returns control to the user.

## Data model

### Element `userData` prefixes (explicit semantics)

| Prefix | Element role | Lifecycle |
|---|---|---|
| `CE_PLUG:<json>` | The section's `+` icon. Carries the `CollapseSection` JSON. While **collapsed** it includes the full `collapsedElements`; while **expanded** that array is dropped (the content is live on the page as `CE_PART`, and recollapse rebuilds it from there) to avoid rewriting the whole payload on every expand. | Created on collapse, updated on expand/recollapse, deleted only if the section is destroyed. |
| `CE_PART:<id>` | A piece of the section's original content currently shown on the page (one per restored stroke / text / link / geometry). | Inserted on expand, deleted on recollapse. |
| `CE_MASK:<id>` | A polygon ring used to fake a filled (white) rectangle that hides content behind the expanded section. | Inserted on expand, deleted on recollapse. |
| `CE_FRAME:<id>` | The thin rectangle outline marking the section boundary. Tagged separately from the fill (kept distinct for clarity / future outline-only operations). | Inserted on expand, rebuilt on a live icon-drag redraw, deleted on recollapse. |
| `CE_NAME:<sectionId>` | One handwritten stroke of a section's optional name. Always visible next to the icon, independent of collapsed/expanded state — unlike `CE_PART`, never hidden. Anchored up-right of the icon on a best-effort basis, clamped at the page edge the same way the icon's own placement already is — not guaranteed collision-free for a long or multi-line name. | Inserted when the user confirms a Name/Rename. Deleted and replaced wholesale on a confirmed rename. Translated whenever the icon moves (collapsed or expanded). Deleted only if the section is destroyed. |
| (null) | Not ours — leave alone. The plugin must not claim or modify these. | — |

### `CollapseSection` (stored as JSON inside `CE_PLUG:`)

- `schemaVersion`: integer; bump when the on-disk shape changes.
- `id`: stable section identifier, used to associate parts/masks back to
  the icon.
- `iconRect`: current bounding rect of the icon on the page.
- `relativeRect`: the content area relative to the icon's top-left —
  `left`/`top` are the offset from the icon to the original content (half an
  icon size, since the icon is placed above-left; less if clamped at the edge),
  and `width`/`height` are the original lasso size. Used to compute
  `contentRect` from the current `iconRect` (`contentRect = iconRect +
  relativeRect offset, sized by relativeRect`).
- `collapsedElements`: serialised originals, ordered to preserve Z-order
  on restore.
- `isExpanded`: boolean — current state machine bit.
- `preservedNums?`: `numInPage` list of every untagged element on the page
  at expand time (i.e. all pre-existing user content). Set on the real
  expand (carried across live redraws), cleared on recollapse. Recollapse
  uses it to tell new strokes drawn on the section (num not in the list)
  apart from pre-existing content, so only the new ones are absorbed.

The serialised section payload (prefix + JSON) must fit in
`MAX_USERDATA_BYTES` (512 KB). If a collapse or recollapse would exceed
that, the plugin must refuse with a clear message rather than truncate.
(The earlier 48 KB value was an arbitrary day-one guess; measured
2026-06-09, the `.note` format persists a 425 KB single-element `userData`
intact and a 223-stroke / 367 KB section round-trips through
collapse→expand cleanly. 512 KB stays well under the ~1 MB binder
transaction limit. Compact stroke encoding, if added, raises the effective
stroke count further within the same byte budget.)

## Visual masking

Because the SDK only exposes outlined geometry (no filled shapes), the
mask is faked by stacking concentric polygon rings whose thick stroke
fills the section's area. The mask must:

- Cover the entire section area as defined by the current `iconRect` plus
  `relativeRect`.
- Not visibly overshoot the section boundary.
- Not leave seams or gaps between adjacent rings.

A thin rectangle outline traces the section boundary to mark the expanded
area more clearly. (A dotted/dashed outline isn't possible — the SDK has no
dashed-line geometry — so the outline is solid.)

Empirical parameters live in `maskHelpers.ts`; tune via the constants
there if rendering changes.

## Constraints / explicit non-goals

- Pictures and titles cannot be collapsed.
- Sections do not nest or overlap. If a user collapses a region that
  contains another section's icon, behaviour is undefined.
- The plugin operates only on the current page; sections do not span
  pages.
- A section can only be named/renamed while collapsed. Naming an expanded
  section is out of scope for v1.
- Removing a name needs no dedicated action: `CollapseSection` never records
  whether a name exists — it's derived purely from whether `CE_NAME` strokes
  are present for that section id. So erasing the name's ink with the
  device's normal eraser (same as erasing any other handwriting) already
  and fully removes it; the section is indistinguishable from one that was
  never named. Erasing only *some* of the name's strokes leaves it
  incomplete rather than gone (the remaining strokes are still tagged), the
  same way partially erasing an expanded section's restored content already
  leaves Recollapse to save only what's left.
- `CE_NAME` strokes are never treated as ordinary page content by any
  operation: never absorbed on recollapse, never swept up as "other
  content" by an unrelated Collapse/Expand, never hidden/restored by
  Expand. They only move when their icon moves.
- Other plugins' `userData` is invisible to this plugin (SDK isolation),
  so we never need to defend against it.

## Known SDK quirks worked around

- `PluginFileAPI.modifyElements` corrupts the geometry of non-icon
  elements when called to update `userData` only. Workaround: keep
  per-element preservation state on the section icon (see
  `preservedNums`) instead of writing tags onto individual strokes.
