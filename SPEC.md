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

The main way to expand or recollapse a section is a single **finger** tap
on its icon or name. The plugin also exposes a **single button**
("Collapse / Expand") on the lasso menu, for everything else — the initial
Collapse, naming, and multi-section actions. Which actions apply is
inferred entirely from what's currently lassoed; there is no per-operation
button.

- REQ-700: If exactly one action applies to the lassoed selection,
  pressing the button runs it straight away, with no dialog.
- REQ-710: If several actions apply to the lassoed selection, pressing the
  button opens a dialog listing them, plus "Cancel".
- REQ-720: Every dialog asking the user to choose, and every message
  about what a selection can or can't do, is titled "Collapse / Expand",
  so the user can tell it comes from this plugin.
- REQ-730: Choosing "Cancel" in any plugin dialog leaves the page exactly
  as it was.
- REQ-740: If no action applies to the lassoed selection, pressing the
  button shows a message saying that a section is expanded or collapsed by
  tapping its icon with a finger.

### Collapse
**Trigger**: user lassoes some content on the page and presses the plugin
button.

**Outcome**:
- The lassoed content disappears from the page.
- A "+" icon appears just above-left of where the lasso was (offset by half
  an icon size, clamped at the page edge), so it stays clear of the restored
  content when the section is later expanded and remains easy to select. The
  icon's glyph reflects the section's current state: "⊕" while collapsed,
  "⊖" while expanded — it flips on every Expand/Recollapse (including a live
  expanded-drag redraw, which keeps it "⊖").
- The icon carries enough state to reproduce the original content
  (positions, ink properties, layer, …) on a later expand.
- REQ-800: Pictures in the lasso are left in place.
- REQ-810: Titles in the lasso are left in place.
- REQ-820: Typed text boxes in the lasso are left in place.
- REQ-830: If the lasso mixes content that can be collapsed with
  pictures, titles or text boxes, a dialog warns, before anything is
  collapsed, that only handwriting, shapes and links will be collapsed,
  offering "Collapse anyway" and "Cancel".
- REQ-835: Choosing "Collapse anyway" collapses the handwriting, shapes
  and links in the lasso.
- REQ-840: If the lasso holds only pictures, titles or text boxes, a
  message says that only handwriting, shapes and links can be collapsed.

### Name / Rename (optional)
**Trigger**: user lassoes **exactly one section's icon** (collapsed or
expanded; no other section) together with handwriting, and presses the
plugin button. Naming is then the only action that applies, so it runs
straight away (REQ-700), except for the confirmation below.

- REQ-610: Lassoing a section's icon together with handwriting that
  belongs to no section sets that handwriting (plus any of the section's
  current name also in the lasso) as the section's name.
- REQ-620: Lassoing a section's icon together with part of that section's
  name sets the lassoed part as the section's name.
- REQ-630: Lassoing a section's icon together with that section's whole
  name sets it as the name again when its underline no longer matches the
  name's width and position (e.g. after part of the name was erased).
- REQ-632: Lassoing a section's icon together with that section's whole
  name sets it as the name again when the name has no underline.
- REQ-635: Lassoing a section's icon together with that section's whole
  name, whose underline still matches it, is handled as if the icon were
  lassoed alone.
- REQ-640: Handwriting that was already on the page under an expanded
  section's area before it was expanded (and is hidden by it) never
  counts as handwriting for naming.
- REQ-670: If naming would remove any stroke of the section's current
  name that isn't in the lasso, a dialog asks for confirmation first,
  offering "Rename" and "Cancel".
- REQ-675: If the section has no name yet, a dialog asks for
  confirmation before setting one, offering "Set as name" and "Cancel".
- REQ-650: After a name is set, its underline spans the new name exactly.
- REQ-660: If every stroke of a section's name has been erased, its
  leftover underline disappears the next time the plugin runs any
  operation on that page.

**Outcome**:
- REQ-530: The lassoed handwriting becomes the section's name.
- REQ-540: The section's previous name, if any, is removed.
- REQ-550: The section stays collapsed or expanded, as it was.
- The name's strokes stay exactly where the user wrote them (no
  repositioning) and remain permanently visible regardless of whether the
  section is collapsed or expanded.
- Available any time, whether the section is collapsed or expanded — not
  limited to right after its own Collapse.
- If the lasso contains untagged ink alongside **more than one** section,
  the naming target is ambiguous: no naming is offered, and the press is
  handled as a multi-section selection instead (see Expand / Recollapse),
  with the ink left in place unless a Recollapse absorbs it.
- The name never moves programmatically except when the user drags the
  icon **while the section is expanded** — in that case it's translated
  live, rigidly, by the icon's exact drag delta on each drag-release
  (matching how restored *content* keeps its own position while the
  mask/outline stretch to reach the moved icon — the name has no anchored
  position of its own, so it follows the icon exactly instead).
  - **While collapsed**, moving the icon, the name, or both (in one drag or
    separately) never auto-relocates the name — Collapse, Recollapse, and
    Expand all leave it exactly where it is. The user repositions the name
    themselves if they want it to stay near a moved icon.
- A thin **underline** is drawn automatically just beneath the name's
  bounding box, spanning its width. It is redrawn (deleted + reinserted)
  exactly when the name itself is (re)written by the plugin: on a confirmed
  Name/Rename, and on the live redraw that translates the name when the
  icon is dragged while expanded. It is **not** kept in sync with a manual
  drag of the name alone (same limitation as the name's own position while
  collapsed — the plugin has no move event for a freeform drag) — if the
  user repositions the name by hand without the plugin's involvement, the
  underline stays at its old position until the next time the plugin
  rewrites the name. Erasing the underline with the normal eraser removes
  it like any other stroke; it is redrawn the next time the plugin rewrites
  the name (rename, or a live redraw), same as a stale one would be, but
  stays gone until then.

### Expand
**Trigger**: a single **finger** tap directly on a collapsed section's icon
**or its name** (if it has one); a pen tap draws ink as normal and is
ignored. Via the button: lassoing the icons of several collapsed sections
(optionally with other content) expands them all — the only action that
applies, so no dialog. Lassoing a single collapsed section alone has no
button action (REQ-740): tap it instead.

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
**Trigger**: a single **finger** tap directly on an expanded section's icon
**or its name**. Via the button: lassoing the icon **or any restored
content** of several expanded sections recollapses them all in one press —
the only action that applies, so no dialog. Lassoing a single expanded
section (its icon or content) has no button action (REQ-740): tap it
instead. For one section's icon plus handwriting, see Name / Rename.

- REQ-350: Lassoing both collapsed and expanded sections and pressing the
  button opens a dialog offering "Expand all sections", "Collapse all
  sections", and "Cancel".
- REQ-360: Choosing "Expand all sections" expands every selected
  collapsed section.
- REQ-370: Choosing "Expand all sections" leaves every selected expanded
  section expanded.
- REQ-380: Choosing "Collapse all sections" recollapses every selected
  expanded section.
- REQ-390: Choosing "Collapse all sections" leaves every selected
  collapsed section collapsed.

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
- REQ-200: Any new content the user draws on top of an expanded
  section's area, after it was expanded, is absorbed into the
  section's saved state the next time it is recollapsed — it
  disappears along with the rest of the section's content and
  reappears the next time the section is expanded.
- REQ-210: Any pre-existing content the user drags into an expanded
  section's area from elsewhere on the page, after it was expanded, is
  absorbed into the section's saved state the next time it is
  recollapsed — the same outcome as REQ-200, whether the content is
  newly drawn or relocated there.
- If absorbing that new content means the section's area (content
  bounding box + margin) would now **cover the icon** (e.g. ink drawn
  overlapping or encircling it), the entire section's content is shifted —
  as one rigid group, preserving every stroke's position relative to the
  others — just far enough that the area clears the icon on the next
  expand. The icon itself never moves. This is different from a user-driven
  icon drag: nothing here reflects user intent to reposition content
  relative to the icon, so the shift is whatever's needed to stop the
  overlap, not something the user controls directly.
- REQ-220: Any content that was already inside an expanded section's
  area at the moment it was expanded remains at its original position,
  untouched, when the section is recollapsed.
- REQ-230: Resizing an expanded section's area — whether by dragging
  its icon or the bottom-right handle (REQ-270) — never absorbs
  anything by itself. If the reshaped area ends up covering content
  that wasn't drawn or moved there by the user, that content is only
  visually hidden beneath the section for as long as it stays covered
  — it is not pulled into the section's saved state, even on a later
  recollapse, unless the user separately draws or drags something into
  the area (REQ-200/REQ-210).
- REQ-240: Content covered by REQ-200 or REQ-210 stays visible through
  a later resize of the section, however it's triggered — reshaping
  the area never hides or disappears it, unlike content that only
  became covered because the area grew (REQ-230).
- REQ-250: Regardless of how an expanded section is resized, every one
  of the section's own strokes stays fully inside the redrawn area —
  the area never shrinks to a size that excludes any of the section's
  own content.
- REQ-260: If dragging the icon would otherwise leave it inside the
  redrawn area, the icon is repositioned to sit just outside the area
  instead — it never ends up hidden beneath the section.
- REQ-270: While a section is expanded, a second handle at the
  bottom-right corner of its area can also be dragged to resize it —
  moving that corner to follow the drag, while the area's top-left
  corner and the icon's own position stay fixed.
- REQ-280: The bottom-right handle is only present while the section
  is expanded — it disappears when the section is recollapsed, and
  reappears (at the area's current bottom-right corner) the next time
  the section is expanded.
- REQ-290: A finger drag on an expanded section's icon resizes the
  section's area the same way a pencil drag on the icon does.
- REQ-310: A finger drag on an expanded section's bottom-right handle
  resizes the section's area the same way a pencil drag on the handle
  does.
- REQ-320: During a finger-drag resize on the icon, nothing on the page
  visibly follows the finger while it's still down — the resized result
  only appears once the finger is lifted.
- REQ-330: During a finger-drag resize on the bottom-right handle,
  nothing on the page visibly follows the finger while it's still down
  — the resized result only appears once the finger is lifted.
- REQ-340: If the page changes during a finger drag on an expanded
  section's icon or handle, the plugin does not attempt to resize
  anything — the section is left exactly as it was.

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
- the strokes that should be preserved across the next recollapse,
- whether an icon being dragged belongs to a currently-expanded section
  (needed to trigger the live redraw described under Recollapse).

The last point applies even though the live redraw is a convenience, not a
correctness mechanism (a missed live redraw doesn't lose or corrupt any
content — the section stays correctly recoverable via a real
Recollapse/Expand). It's listed here because dragging the icon of an
expanded section to reshape it is itself a valid operation the user may
reasonably perform right after power-on, and it must not silently do
nothing.

In practice this means **every piece of state the plugin relies on must
live on disk** in element `userData` (icon, parts, masks) or in the
element list itself. No state may live only in JS memory across a
collapse / expand / recollapse cycle.

If a new feature ever needs state that doesn't fit in a single element's
`userData`, that state must be serialised onto a stable, persisted
location (typically the section icon's `userData`) before the operation
returns control to the user.

## Permissions

Some operations need the user's permission to read or change note content
directly. The host may show a permission dialog before such an operation
can proceed. Rather than asking incrementally as new operations are
tried, the plugin asks for everything it might ever need together, the
first time the user does anything with it at all — whichever comes
first, a tap or a button-triggered operation. The plugin's finger-tap
shortcut (Expand/Recollapse by tapping a section's icon) is what makes
"a tap" a possible first interaction: since it can't tell in advance
whether a given tap even targets one of its icons, it asks on the
user's first single-finger tap of any kind, not tied to a hit — see
REQ-090/100.

REQ-010: The first time the user triggers Collapse, Expand, Recollapse,
Name/Rename, or a section icon drag, and the plugin does not currently
have every permission that operation needs, the host's standard
permission dialog is shown before the operation makes any change to the
page.

REQ-020: A prior decline does not stick permanently from the plugin's
own perspective: the next time the user triggers an operation that
needs a permission that was previously declined (or only granted "this
time" and is no longer in effect), the plugin asks again, rather than
silently treating that permission as permanently unavailable for that
operation.

REQ-030: If the triggered operation needs more than one permission the
user doesn't yet have, the user may see more than one permission dialog
in sequence — not a single combined prompt.

REQ-040: If the user grants every permission the triggered operation
needs, the operation proceeds and completes normally, with no visible
difference from a case where the permission was already granted.

REQ-050: If the user denies a permission the triggered operation needs,
the page is left completely unchanged — no partial collapse, expand,
recollapse, rename, or icon redraw takes place.

REQ-060: If the user denies a permission the triggered operation needs,
a message is shown explaining that the plugin needs permission to make
the requested change, and where to grant it.

REQ-070: Once the user has granted a permission "always," triggering an
operation that needs only that permission again does not show a dialog
for it, unless the user later revokes the permission themselves.

REQ-080: If the plugin cannot obtain a needed permission for a reason
other than the user explicitly declining it, an operation the user
triggered still leaves the page completely unchanged and still shows
the same explanatory message as an explicit denial — it never behaves
as if the button press did nothing.

REQ-090: The first time the user makes a single-finger tap of any kind
(whether or not it lands on a section's icon or its name), if the
plugin does not yet have every permission it may ever need, the host's
standard permission dialog is shown for each one still missing.

REQ-100: If the user denies a permission requested under REQ-090, no
message is shown for it — the tap shortcut simply stays inactive, as if
the tap had landed on nothing, rather than surfacing an error for a tap
that may not even have been meant for the plugin.

REQ-110: Once the permissions requested under REQ-090 have been resolved
(granted or declined) for the current plugin activation, they are not
requested again via another tap in the same activation, even if some were
declined — unlike REQ-020's guarantee, which is specific to
button-triggered operations. Declining one via a tap does not, however,
prevent it from being requested again the next time the user triggers a
button-driven operation that needs it (REQ-010, REQ-020).

## Data model

### Element `userData` prefixes (explicit semantics)

| Prefix | Element role | Lifecycle |
|---|---|---|
| `CE_PLUG:<json>` | The section's `+` icon. Carries the `CollapseSection` JSON. While **collapsed** it includes the full `collapsedElements`; while **expanded** that array is dropped (the content is live on the page as `CE_PART`, and recollapse rebuilds it from there) to avoid rewriting the whole payload on every expand. | Created on collapse, updated on expand/recollapse, deleted only if the section is destroyed. |
| `CE_PART:<id>` | A piece of the section's original content currently shown on the page (one per restored stroke / text / link / geometry). | Inserted on expand, deleted on recollapse. |
| `CE_MASK:<id>` | A stroke ring used to fake a filled (white) rectangle that hides content behind the expanded section. | Inserted on expand, deleted on recollapse. |
| `CE_FRAME:<id>` | The thin rectangle outline marking the section boundary. Tagged separately from the fill (kept distinct for clarity / future outline-only operations). | Inserted on expand, rebuilt on a live icon-drag or handle-drag redraw, deleted on recollapse. |
| `CE_HANDLE:<id>` | A small glyph at the expanded section's bottom-right corner; dragging it resizes the area, independently of dragging the icon. | Inserted on expand, repositioned on a live icon-drag or handle-drag redraw, deleted on recollapse. |
| `CE_NAME:<sectionId>` | One handwritten stroke of a section's optional name. Stays exactly where the user wrote it — never repositioned on creation. Always visible, independent of collapsed/expanded state — unlike `CE_PART`, never hidden. | Inserted when the user confirms a Name/Rename. Deleted and replaced wholesale on a confirmed rename. Translated only when the icon is dragged while the section is expanded (see Recollapse). Deleted only if the section is destroyed. |
| `CE_UNDERLINE:<sectionId>` | A single geometry line spanning the name's current bounding box, drawn just beneath it. Not treated as part of the name's own content (a rename replaces it, doesn't fold it in). | Inserted/redrawn (delete + reinsert) whenever the plugin (re)writes the name: Name/Rename confirmation, and the live redraw that translates the name on an expanded icon-drag. Deleted only if the section is destroyed. |
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

REQ-300: While a section is expanded, its content behaves like
ordinary page content — the user can interact with it (select, edit,
erase, and any other standard note-taking action) almost as if the
section didn't exist. 

Empirical parameters live in `maskHelpers.ts`; tune via the constants
there if rendering changes.

## Section identity

- REQ-400: If copy-pasting a section's icon while it's collapsed
  produces two icons that would otherwise act as the same section
  (e.g. recollapsing or expanding one also affects the other), the
  plugin corrects this the next time it gets the opportunity, without
  altering either section's content — the two then behave as fully
  independent sections.

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
- `CE_UNDERLINE` is subject to the same exclusions as `CE_NAME` (never
  absorbed, swept up, or hidden/restored) — it's the name's visual
  companion, not section content.
- Other plugins' `userData` is invisible to this plugin (SDK isolation),
  so we never need to defend against it.

## Known SDK quirks worked around

- `PluginFileAPI.modifyElements` corrupts the geometry of non-icon
  elements when called to update `userData` only. Workaround: keep
  per-element preservation state on the section icon (see
  `preservedNums`) instead of writing tags onto individual strokes.
