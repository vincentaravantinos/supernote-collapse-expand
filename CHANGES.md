# Changes

## Unreleased

- Change: the collapsed-section icon is now a text glyph (⊕) instead of a
  bundled picture element. On the current beta firmware, picture inserts
  triggered an SDK bridge desync that made `insertElements` silently no-op
  (collapse deleted strokes but produced no icon). Switching the icon to a
  TEXT element dodges that, and removes the whole class of picture-element
  workarounds: the `picturePath`/1211 re-anchor in `writeSection`, the
  `iconShrinkWorkaround` (moved pictures rescaled to ~14×14), and the
  stale-lasso-rect handling. Icon position is read from `textBox.textRect`.

- Fix: the `+` icon no longer stays shrunk after being moved. An SDK bug
  rescales a moved picture element to ~14×14 when the move is committed
  (any save, plugin or not). Since `modifyElements` can't reset a
  picture's rect, expand/recollapse now re-create the icon at its proper
  size when they detect it shrank. Isolated in
  `src/utils/iconShrinkWorkaround.ts`; when the SDK fixes the rescale
  (see FEEDBACK.md), delete that file and the two `restampIconIfShrunk`
  calls in `expandAction.ts` / `recollapseAction.ts`.

- Fix: expanding (or recollapsing) a section after moving its `+` icon now
  restores the content at the icon's new location instead of its original
  one. The icon's current position is read from `getElements` (matched by
  section id) rather than from the lassoed element, which reports a stale
  pre-move rect for picture elements. See SDK_DOC.md / FEEDBACK.md.

- Change: the collapsed-section icon is now a bundled `icon_plus.png`
  picture element instead of a `+` text glyph, so it renders
  consistently regardless of the user's current pen / text style.
- Fix: expand and recollapse no longer fail with SDK error 1211
  ("PNG file does not exist") when updating the icon's `userData`. The
  icon's `picture.picturePath` is now re-anchored to the bundled icon on
  disk before `modifyElements`, instead of trusting the phantom cache
  path the SDK returns from `getElements`.
- Fix: pre-existing strokes drawn around a collapsed section no longer
  vanish after an expand → recollapse cycle. Their `numInPage` is recorded
  on the section state during expand and skipped from the absorb-and-delete
  path during recollapse.
- Fix: recollapse no longer misses strokes near the edge of the section's
  area. Restored part elements are now tagged with `CE_PART:<id>` userData,
  so recollapse re-collapses them by tag lookup instead of relying on a
  geometry-based lasso that was brittle to EMR/pixel rounding at the
  boundary.
- Fix: recollapse re-collapses the section's restored content again. The
  expand path was tagging restored part elements with the bare section id
  instead of `CE_PART:<id>`, so recollapse's tag lookup never matched them
  (`partEls` came back empty) and the content stayed on the page. Parts are
  now written with the correct `CE_PART:` prefix, symmetric with masks.