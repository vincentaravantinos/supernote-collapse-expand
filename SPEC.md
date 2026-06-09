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

### Collapse
**Trigger**: user lassoes some content on the page and presses the plugin
button.

**Outcome**:
- The lassoed content disappears from the page.
- A "+" icon appears at the top-left of where the lasso was.
- The icon carries enough state to reproduce the original content
  (positions, ink properties, layer, …) on a later expand.
- Pictures and titles in the lasso are left in place (not collapsable).

### Expand
**Trigger**: user lassoes the "+" icon of a collapsed section and presses
the plugin button.

**Outcome**:
- The original content reappears at its location (translated if the icon
  was moved while collapsed).
- A visual mask covers the section's area so any user content the user
  drew on top of (or under) the icon while collapsed is hidden behind the
  expanded section.
- Pre-existing user content sitting under the section's area must be
  remembered so it can be told apart from content the user adds *during*
  expansion (see Recollapse).

### Recollapse
**Trigger**: user lassoes the "+" icon of an expanded section and presses
the plugin button.

**Outcome**:
- The "+" icon stays where it is.
- All restored content disappears again.
- The mask is removed.
- Any **new** strokes the user drew on top of the expanded section are
  absorbed into the section's saved state (so they reappear on the next
  expand).
- Any content that was sitting on the page **before** the expand and
  happened to be inside the section's area must remain at its original
  position, untouched by recollapse.

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
| `CE_MASK:<id>` | A polygon ring used to fake a filled rectangle that hides content behind the expanded section. | Inserted on expand, deleted on recollapse. |
| (null) | Not ours — leave alone. The plugin must not claim or modify these. | — |

### `CollapseSection` (stored as JSON inside `CE_PLUG:`)

- `schemaVersion`: integer; bump when the on-disk shape changes.
- `id`: stable section identifier, used to associate parts/masks back to
  the icon.
- `iconRect`: current bounding rect of the icon on the page.
- `relativeRect`: size of the original lasso area, used to compute
  `contentRect` from the current `iconRect`.
- `collapsedElements`: serialised originals, ordered to preserve Z-order
  on restore.
- `isExpanded`: boolean — current state machine bit.
- `preservedNums?`: `numInPage` list of pre-existing user content that
  was sitting inside the section's area when it was expanded. Set on
  expand, cleared on recollapse. Used so recollapse can tell those
  elements apart from content drawn during expansion.

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

Empirical parameters live in `maskHelpers.ts`; tune via the constants
there if rendering changes.

## Constraints / explicit non-goals

- Pictures and titles cannot be collapsed.
- Sections do not nest or overlap. If a user collapses a region that
  contains another section's icon, behaviour is undefined.
- The plugin operates only on the current page; sections do not span
  pages.
- Other plugins' `userData` is invisible to this plugin (SDK isolation),
  so we never need to defend against it.

## Known SDK quirks worked around

- `PluginFileAPI.modifyElements` corrupts the geometry of non-icon
  elements when called to update `userData` only. Workaround: keep
  per-element preservation state on the section icon (see
  `preservedNums`) instead of writing tags onto individual strokes.
