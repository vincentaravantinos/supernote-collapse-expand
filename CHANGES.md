# Changes

## Unreleased

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