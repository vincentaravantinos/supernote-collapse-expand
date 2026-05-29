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
