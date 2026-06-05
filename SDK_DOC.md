# Supernote SDK — Our Notebook

What we've learned about the Supernote plugin SDK by experiment, beyond
what the official docs at https://docs.supernote.com/en cover. The
official docs are thin and frequently silent on the lifecycle of values
the SDK returns; this file is the practical complement.

For each entry: include the SDK version / observation date, the
evidence (trace or adb output), and the implication for plugin code.
If something here is also worth feeding back to Ratta, log it in
FEEDBACK.md and link the two.

---

## Picture elements — `picture.picturePath` is rewritten on save to a phantom cache path

**Observed**: 2026-05-29, against the current beta SDK build.

**What happens**:

1. When inserting a picture element we provide a real on-disk path, e.g.
   `/data/user/0/com.ratta.supernote.pluginhost/files/plugins/<plugin-id>/icon_plus.png`.
2. `insertElements` does not mutate our in-memory element object — its
   `picture.picturePath` still points at the bundled file after the call.
3. After `saveCurrentNote`, re-reading the element via `getElements` (or
   `getLassoElements`) returns a **different** `picturePath`, of the
   form `/storage/emulated/0/.data/plugin/<millis>.png`. This is an
   SDK-internal cache reference.
4. The cache file at that path **does not actually exist** on disk
   (verified with `adb shell ls`). Yet the picture renders correctly,
   so the PNG bytes are presumably stored elsewhere — most likely
   embedded inside the `.note` file alongside strokes.

**Implication for plugin code**:

- Never trust `picture.picturePath` from `getElements` /
  `getLassoElements` round-trips. Treat it as opaque / unreliable.
- Before calling any SDK API that reads the source PNG from
  `picture.picturePath` (notably `modifyElements`), **re-anchor it to a
  path you control**. For the icon, that means resolving the bundled
  asset path fresh via `PluginManager.getPluginDirPath()` and assigning
  `picture.picturePath = <pluginDir>/<filename>` before the call.
- `modifyElements` on a picture element fails with error code 1211
  ("PNG file does not exist. Cannot call the API!") if the
  `picturePath` doesn't resolve to a readable file at call time. This
  is true even when the only field you wanted to update was `userData`.

**Where this is worked around in our code**: `src/utils/userDataManager.ts`
inside `writeSection`.

**Related FEEDBACK.md entry**: "Bug: `getElements` returns a
`picture.picturePath` that doesn't exist on disk; `modifyElements` then
fails with code 1211".

---

## Cache directory `/storage/emulated/0/.data/plugin/` is never cleaned up

**Observed**: 2026-05-29.

**What happens**: every picture insert appears to allocate a file name
(of the form `<millis>.png`) in this directory. Whether the bytes are
ever written there is inconsistent (see picture-path entry above), but
either way the directory accumulates files indefinitely — we observed
**159 files** going back over a month on a single device, including
many that survived note deletion.

**Implication for plugin code**: nothing actionable on our side, but
worth knowing this is a slow disk leak on the device and not a
plugin-side bug if a user reports it.

**Related FEEDBACK.md entry**: "Side observation (cache leak)" inside
the picture-path bug section.

---

## `getLassoElements` returns a STALE `picture.rect` after a move; `getElements` is fresh

**Observed**: 2026-06-05, on Manta/A5X plugin-preview beta build
`Chauvet.D102.2605151001.2337_beta` (build date 2026-05-15 — the
2026-05-15 plugin-preview from r/Supernote_dev post `1tdw909`).

**Context**: that build's changelog explicitly claims:

> Fixed an issue where the coordinates retrieved through the API did not
> update after moving an element and still showed the pre-move values.

For **picture** elements that fix only reaches the persisted
`getElements` path, **not** the element handed back by
`getLassoElements`.

**Trace evidence** (one move-then-expand cycle; section saved at
`iconRect=[448,614,498,664]`, then the icon was dragged):

- `getLassoElements` element: `picture.rect=[448,614,498,664]` — the
  **pre-move** position (stale). No other position field is populated on
  a picture element (`textBox.textRect`, top-level `rect`, `x/y`,
  `boundingRect` are all absent; `maxX/maxY` are page EMR dimensions, not
  a position).
- Same icon (`numInPage=5`) via `getElements` after `saveCurrentNote`:
  `picture.rect=[585,1123,599,1137]` — the **moved** position.

Consistent with the already-documented phantom-cache behaviour of
lassoed picture elements (see the `picture.picturePath` entry above): the
lassoed picture element is served from a stale cache.

**Implication for plugin code**: to read a picture icon's *current*
position (e.g. to translate restored content by how far the user moved
the icon), resolve it from `getElements` matched by our `userData`
section id — never from the lassoed element. Flush with `saveCurrentNote`
first so `getElements` reflects the move. Implemented as
`iconRectFromElements` / `getCurrentIconRect` in `userDataManager.ts`,
used by `expandAction` and `recollapseAction`.

**Side note (separate bug)**: `getElements` reports the moved picture's
rect as ~14×14 although it was inserted at 50×50 (`ICON_SIZE`); the icon
also visibly shrinks to the user after a move. Only the top-left is used
for the translation delta, and on-device validation showed restored
content lands correctly, so this doesn't affect the position fix. Tracked
as a separate backlog item.

**Related FEEDBACK.md entry**: "Bug: documented move-coordinate fix does
not reach `getLassoElements` for picture elements".

---

## Moving a picture shrinks it on commit; `modifyElements` can't resize a picture

**Observed**: 2026-06-05, build `Chauvet.D102.2605151001.2337_beta`.

**What happens**:
- A picture element inserted at 50×50 keeps that size as long as it's not
  moved. The moment a *move* is committed to the page (by **any** save —
  our `saveCurrentNote`, or the app's autosave when the user taps
  elsewhere after dragging), the SDK rescales it to ~14×14. Position is
  preserved; only the size is corrupted. Reproducible with no plugin at
  all (place picture → drag → tap elsewhere).
- `modifyElements` updates an element's `userData` but does **not** apply
  a picture's `rect` — passing a 50×50 rect through `modifyElements`
  leaves the on-page picture at 14×14.
- `insertElements` **does** honour `rect` (that's how the 50×50 icon is
  created at collapse).

**Implication for plugin code**: to resize a picture you must delete and
re-insert it; `modifyElements` won't do it. We restore the section `+`
icon this way in `iconShrinkWorkaround.ts` (`restampIconIfShrunk`), called
at the end of expand/recollapse and gated on `width !== ICON_SIZE` so it
only fires when the icon was actually moved.

**Related FEEDBACK.md entry**: "Bug: `saveCurrentNote` rescales a moved
picture element to ~14×14 on commit".
