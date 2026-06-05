# Feedback to Supernote / Ratta SDK developers

## Bug: `getElements` returns a `picture.picturePath` that doesn't exist on disk; `modifyElements` then fails with code 1211

**Observed in**: this plugin, against the current beta SDK build
(2026-05-29).

**Symptom**: calling `PluginFileAPI.modifyElements` on an existing
picture element (round-tripped through `getElements` /
`getLassoElements`) to update its `userData` fails with:

```
{"error":{"message":"PNG file does not exist. Cannot call the API!","code":1211},"success":false}
```

…even though the picture renders correctly on the page.

**Trace evidence**:

1. At insert time, we hand the SDK a real, readable path under the
   plugin's install dir:
   ```
   picturePath="/data/user/0/com.ratta.supernote.pluginhost/files/plugins/com.supernote.plugin.collapseexpand/icon_plus.png"
   ```
2. `insertElements` succeeds. Our in-memory `iconEl` is **not** mutated
   by the SDK — its `picturePath` still points at the bundled icon.
3. After `saveCurrentNote`, re-reading the element via `getElements`
   returns a **rewritten** path that points into an SDK-internal cache:
   ```
   picturePath="/storage/emulated/0/.data/plugin/1780033689720.png"
   ```
4. That cache file **does not actually exist on disk**
   (`adb shell ls` returns "No such file or directory"). Yet the picture
   still renders fine, so the PNG bytes are presumably stored elsewhere
   (embedded in the .note file?).
5. When we call `modifyElements` with this round-tripped element, the
   SDK tries to read the phantom cache path and fails with 1211.

**Workaround in place**: in our `writeSection` helper, immediately before
`modifyElements`, we overwrite `iconElement.picture.picturePath` with
the original on-device bundled-icon path (resolved fresh via
`PluginManager.getPluginDirPath()`). This unblocks `modifyElements`
without changing what the user sees.

**Bug requests**:

- `getElements` / `getLassoElements` should return a `picturePath` that
  is actually readable — either the original source path or a real
  cached file. Returning a path that doesn't exist on disk is a footgun.
- `modifyElements` on a picture element should be able to update fields
  like `userData` without re-reading the source PNG. If the bytes are
  already persisted inside the .note file (as the rendering behaviour
  suggests), a userData-only modify should not need the source PNG at
  all.
- Document the lifecycle of `picture.picturePath`: who owns it, when
  it's rewritten, whether the cache file is guaranteed to exist while
  the element is on the page, and what plugin authors should pass back
  on subsequent `modifyElements` calls.

**Side observation (cache leak)**: the `/storage/emulated/0/.data/plugin/`
directory accumulates one PNG per picture insert and never appears to be
cleaned up — we observed 159 files going back over a month on a single
device. If these are referenced from notes the user has deleted, this is
a slow disk leak. Worth a separate audit.

## Observed: stroke geometry shifted after `modifyElements` (likely cache/file ordering)

**Observed in**: this plugin, against the current beta SDK build
(initial observation 2026-05-06; further investigation 2026-05-08).

**Original symptom**: calling `modifyElements` on an existing stroke
element to update *only* its `userData` field appeared to overwrite the
element's `maxX/maxY` so they matched the icon's coordinates rather than
the stroke's own, and the stroke visibly shifted on screen.

**Trace evidence (original bug)**:
- Before: `(num=6 type=0 udLen=n/a maxX=20967 maxY=15725)` — the stroke.
- After: `(num=6 type=0 udLen=23 maxX=15819 maxY=11864)` — identical to
  the icon's `maxX/maxY`.

**Update — likely root cause**: an isolated repro of the same
`modifyElements` call (just modify+save+read, no surrounding expand
action) does **not** reproduce the geometry shift. We now suspect the
original symptom was caused by the cache/file ordering issue documented
in `saveCurrentNote`, not by `modifyElements` itself. The doc says:

> When operating on the currently opened note, changes are typically
> written to an in-memory cache and are not persisted to the file
> immediately. If you call file-related APIs without saving (e.g.
> replaceElements, insertElements, modifyElements etc.), the data state
> may become inconsistent. It is recommended to call saveCurrentNote
> first to persist cached data to the file, and then perform file-level
> read/write operations.

In the original bug we called `modifyElements` *without* a preceding
`saveCurrentNote`. The user's strokes were still in the cache, the file
state didn't reflect them, and the subsequent operations caused a
write-merge race with visible side effects on geometry.

**Workaround in place**: we no longer call `modifyElements` on
pre-existing strokes; we carry per-stroke flags on the section icon's
own `userData` (which is the element we're already updating via the
existing safe `writeSection` path).

(A separate documentation gap, below, calls out that the doc itself is
too vague to make this rule actionable in practice.)

## Documentation gap: `Element.maxX` / `Element.maxY`

**Current doc** (`Element.ts`):

```
public maxX: number = 0; // Max coordinate value
public maxY: number = 0; // Max coordinate value
```

**Why this is unclear**: a developer reading this will reasonably assume
`maxX/maxY` is the maximum point coordinate of the element (its bounding
box's right/bottom edge in EMR units). It is not.

**What we observed**:
- A stroke whose `stroke.points` reach (~15621, …) reports `maxX=20967`.
- Two strokes drawn at different positions on the same page report the
  same `maxX/maxY` of `(20967, 15725)`.
- A TEXT element on the same page reports a different pair, e.g.
  `(15819, 11864)`, regardless of the actual `textRect`.
- These values match (or are very close to) `PointUtils.getRealMaxX/Y`
  for the page.

So `maxX/maxY` looks like **coordinate-space metadata** — the reference
ruler the element's points are interpreted against — rather than a
per-element bounding box. The same numerical points produce a different
on-screen position depending on this value.

**Doc improvement requested**:
- Rename or rephrase the comment to say what these fields actually are
  ("coordinate-space reference; the element's points are in this space").
- Spell out the invariant: changing `maxX/maxY` while leaving
  `stroke.points` untouched will visibly shift the element.
- Document whether (and when) the SDK is allowed to overwrite these
  fields on `modifyElements` / `insertElements` calls.
- If `maxX/maxY` differ by element type (we observed stroke vs. TEXT
  having different defaults), state that explicitly.

## Documentation gap: other `Element` / `Stroke` fields are also under-documented

The `maxX/maxY` gap above isn't isolated — most of the fields on the
`Element` and nested `Stroke` types are either undocumented or have a
one-word comment that doesn't tell a developer what value to read or
write. When `getElements` returns objects like the one below, it's
genuinely hard to know what's safe to inspect, modify, or pass back:

```json
{
  "stroke": {
    "recognPoints":      { "uuid": "…", "type": 7, "_size": -1, "cache": {}, "cacheRanges": [], "dataType": "recognData" },
    "markPenDirection":  { "uuid": "…", "type": 6, "_size": -1, "cache": {}, "cacheRanges": [], "dataType": "point" },
    "penColor": 0,
    "eraseLineTrailNums":{ "uuid": "…", "type": 4, "_size": -1, "cache": {}, "cacheRanges": [], "dataType": "number" },
    "pressures":         { "uuid": "…", "type": 3, "_size": -1, "cache": {}, "cacheRanges": [], "dataType": "number" },
    "penType": 16,
    "flagDraw":          { "uuid": "…", "type": 5, "_size": -1, "cache": {}, "cacheRanges": [], "dataType": "boolean" },
    "points":            { "uuid": "…", "type": 2, "_size": -1, "cache": {}, "cacheRanges": [], "dataType": "point" }
  },
  "angles":              { "uuid": "…", "type": 0, "_size": -1, "cache": {}, "cacheRanges": [], "dataType": "point" },
  "contoursSrc":         { "uuid": "…", "type": 1, "_size": -1, "cache": {}, "cacheRanges": [], "dataType": "pointArray" },
  "status": 0,
  "numInPage": 1,
  "recognizeResult": { "predict_name": "others", "up_left_point_x": 428, "up_left_point_y": 714, "down_right_point_x": 665, "down_right_point_y": 881, "key_point_x": 547, "key_point_y": 797 },
  "maxY": 15725, "thickness": 300, "pageNum": 0, "maxX": 20967,
  "layerNum": 0, "type": 0, "uuid": "…"
}
```

**Fields a plugin author cannot reason about from the current docs**:

- `angles` — what is this? Per-point tangent angles? Pen orientation?
  Stroke segment angles? The `dataType: "point"` is misleading because
  the field name suggests scalars. Need: what's stored, in what units,
  one entry per what (per point? per segment? per contour?).
- `contoursSrc` — "source contours" of what? Outline of the rendered
  stroke for rendering/hit-testing? Original input before smoothing?
  Are these closed polygons or polylines? How many contours does a
  single stroke produce, and in what order?
- `recognPoints` / `markPenDirection` / `eraseLineTrailNums` /
  `flagDraw` — these are all lazy `_size: -1` handles, so I can't even
  see their values from a `JSON.stringify`. The doc needs to spell out
  what each holds, when it's populated (only for certain pen types?
  only after recognition runs?), and whether reading them forces
  materialization.
- `status` — `0` is the only value we've seen. What other values exist
  and what do they mean? "Pending recognition", "deleted but tombstoned",
  "selected"? Without an enum a developer can't pattern-match on status.
- `type` (top-level `0` on the element vs. the inner stream `type` 0..7
  on each lazy buffer) — these are the same name but appear to mean
  different things (element kind vs. per-buffer payload kind). Both
  need an enum table.
- `penType: 16` — there's no public list of `penType` values. Is 16
  fineliner? Marker? Highlighter? Plugin authors writing strokes
  programmatically have to guess.
- `layerNum`, `numInPage`, `pageNum` — relationship between these
  three isn't documented. Is `numInPage` a stable id within a page, an
  index, or a z-order? Does it survive insert/delete of other
  elements? Same question for `layerNum`.
- `recognizeResult.predict_name` — what's the full set of values
  ("others" is just one)? When is `recognizeResult` populated vs
  absent vs `null`?
- The lazy `_size: -1` / `cache` / `cacheRanges` pattern itself is
  undocumented. How does a developer materialize one of these — is
  there a public API, or are they internal? If internal, the doc
  should say "do not read these directly, use API X".

**Doc improvement requested**:

- Per-field comment on every public property of `Element` and `Stroke`
  saying *what the value represents*, *in what units*, *when it's
  populated*, and *whether plugins may mutate it*.
- An enum / constants table for every integer-coded field
  (`type`, `status`, `penType`, `penColor`, layer numbers, the inner
  buffer `type` 0..7, etc.).
- A short "lifecycle of a stroke" page: where each field comes from
  (user input vs. recognition vs. layout pipeline), and which ones a
  plugin is allowed to write back via `modifyElements` /
  `insertElements`.

Without this, plugin authors have to reverse-engineer field semantics
from observed traces, which produces fragile plugins and the kind of
"why did geometry shift" mystery documented in the section above.

## Documentation gap: `PluginCommAPI.setLassoBoxState`

**Current doc** (`PluginCommAPI.ts`):

```
* @param {number} state Lasso box state: 0=Show, 1=Hide, 2=Completely remove
```

**Why this is unclear**: "Completely remove" is ambiguous. Does it remove
only the lasso *UI box*, or does it also affect the *contents* of the
lasso (the selected elements)? Likewise, "Hide" doesn't say whether the
selection is still active (and whether subsequent `getLassoElements`
calls still return the selected elements).

**Doc improvement requested**: for each state value, clarify:
- What happens to the lasso UI (visible / hidden / gone).
- What happens to the *selection* (still active / cleared).
- What happens to the *elements* that were inside the lasso (left in
  place / committed back to the page / lifted into a transient state /
  destroyed).
- What `getLassoElements` and `lassoElements(rect)` will return after
  each state change.

Suggested phrasing:

```
* @param {number} state Lasso box state.
*   0 = Show: lasso UI visible, selection active.
*   1 = Hide: lasso UI hidden but selection still active; elements stay
*       in their lifted state and getLassoElements still returns them.
*   2 = Completely remove: clear the selection entirely; elements drop
*       back to the page in their original positions; getLassoElements
*       returns an empty list afterwards.
```

(If our suggested semantics don't match the implementation, the doc
should describe the actual behaviour — the point is that all three
states need to be unambiguous about elements vs. UI vs. selection.)

## Documentation gap: cache vs file APIs

The `saveCurrentNote` doc helpfully acknowledges a cache/file split:

> When operating on the currently opened note, changes are typically
> written to an in-memory cache and are not persisted to the file
> immediately. If you call file-related APIs without saving (e.g.
> replaceElements, insertElements, modifyElements etc.), the data state
> may become inconsistent. It is recommended to call saveCurrentNote
> first to persist cached data to the file, and then perform file-level
> read/write operations.

This is the right idea, but in practice it's too vague to act on
reliably. Several questions are unanswered:

1. **Which APIs are cache-based and which are file-based?** The note
   explicitly calls out three (`replaceElements`, `insertElements`,
   `modifyElements`) but uses "etc.". Developers need a complete
   classification. Each API across `PluginFileAPI`, `PluginCommAPI`,
   `PluginNoteAPI`, etc. should be marked: cache-backed / file-backed /
   mixed (and if mixed, what part lives where).

2. **Required vs recommended.** "It is recommended to call
   saveCurrentNote first" — but is it merely recommended, or is it
   required to avoid silent corruption? If it's required, say so. We've
   seen at least one case (`modifyElements` userData write) where
   skipping the pre-save led to an apparent silent failure (`success=true`
   returned but the write didn't land).

3. **Reads.** `getElements` is in `PluginFileAPI` — does it read from
   the cache or the file? If it's file-based, will it see a write that's
   still in the cache? Conversely, will the cache mask file writes from
   recent file-level calls? The doc only addresses writes.

4. **Interaction with lasso state.** Empirically a `saveCurrentNote`
   call appears to interact with active lasso state (clearing or
   committing it). When there's an active lasso, we observed strokes
   disappearing from `getElements` after a single
   `insertElements + saveCurrentNote` pair. The doc doesn't mention
   this interaction at all.

5. **Canonical patterns.** A copy-pasteable canonical sequence for the
   common cases ("modify userData on an existing stroke and read it
   back", "insert new elements and verify them", "delete then read")
   would prevent every plugin author from rediscovering this independently.

Concretely, two doc additions would solve most of this:

- A table in the SDK overview listing each public API with a
  `cache | file | mixed` column and a short note on when a pre-save is
  required.
- A "Common patterns" page with worked examples for each of the
  scenarios above, including the right `saveCurrentNote` placements.

## Bug: documented move-coordinate fix does not reach `getLassoElements` for picture elements

**Observed in**: this plugin, on plugin-preview beta build
`Chauvet.D102.2605151001.2337_beta` (build date 2026-05-15).

**Context**: this build's changelog states:

> Fixed an issue where the coordinates retrieved through the API did not
> update after moving an element and still showed the pre-move values.

**Symptom**: for a **picture** element, that fix only applies to the
persisted `getElements` path. The element returned by `getLassoElements`
(after the user lassoes the moved picture) still reports the **pre-move**
`picture.rect`.

**Trace evidence** (section icon dragged from `[448,614,498,664]`):

- `getLassoElements` → `picture.rect=[448,614,498,664]` (pre-move, stale).
- `getElements` (same icon, after `saveCurrentNote`) →
  `picture.rect=[585,1123,599,1137]` (moved, correct).

**Workaround in place**: read the icon's current rect from `getElements`
(matched by our `userData` section id), not from the lassoed element.

**Bug requests**:

- Apply the move-coordinate fix to `getLassoElements` as well, so the
  lassoed element reports the same up-to-date `picture.rect` as
  `getElements`. Plugins commonly act on the lassoed element directly;
  having it disagree with `getElements` is a footgun.
- If the lassoed element is intentionally served from a cache, document
  that its geometry can be stale and direct authors to `getElements` for
  authoritative coordinates.

**Side observation (separate bug)**: moving a picture element appears to
**rescale** it — inserted at 50×50, `getElements` then reports its
`picture.rect` as ~14×14, and the icon visibly shrinks on screen. Moving
an element should not change its rendered size. Worth a separate look.

**Related SDK_DOC.md entry**: "`getLassoElements` returns a STALE
`picture.rect` after a move; `getElements` is fresh".

## Bug: `saveCurrentNote` rescales a moved picture element to ~14×14 on commit

**Observed in**: this plugin, on plugin-preview beta build
`Chauvet.D102.2605151001.2337_beta` (build date 2026-05-15).

**Symptom**: a picture element inserted at 50×50 visibly shrinks to
~14×14 the moment a *move* is committed back to the page. Only moved
pictures are affected — a picture left in place never changes size.

**Reproducible with no plugin at all**: insert/place a picture, drag it
to a new spot, then tap elsewhere (which triggers the app's autosave).
The picture shrinks on that save. It is the *commit of a moved picture*
that corrupts the size, not anything plugin-specific — our plugin only
hits it because `expandAction` calls `saveCurrentNote` after the user has
moved the icon.

**Trace evidence** (one move-then-expand; icon inserted at 50×50, then
dragged, then plugin pressed — we logged the icon's `picture.rect` and
its width×height at successive steps):

```
A lassoedElement.picture.rect = [526,680,576,730]  50x50   (selection copy)
B getElements BEFORE save      = [526,680,576,730]  50x50   (on-file, pre-move-commit)
C getElements AFTER save       = [571,1162,585,1176] 14x14  (moved AND shrunk)
E getElements AFTER modifyElements = [571,1162,585,1176] 14x14 (still shrunk)
```

So the single `saveCurrentNote` call between B and C both commits the
move (correct) **and** rescales the picture from 50×50 to 14×14
(incorrect). The position is preserved; only the size is corrupted.

**Second bug surfaced by the same trace**: `modifyElements` cannot
repair it. Step E ran `modifyElements` on the icon with a 50×50
`picture.rect`, and the element stayed 14×14 — i.e. `modifyElements`
updates `userData` but does **not** apply a picture element's `rect`.

**Workaround in place**: because only `insertElements` honours a
picture's `rect`, we detect the shrunk icon (width ≠ our `ICON_SIZE`) and
re-create it — delete the shrunk element and insert a fresh 50×50 picture
at the same top-left, carrying the same `userData`. This is heavier than
it should be (an element id churns on every move) and we'd much rather
not have to.

**Bug requests**:

- `saveCurrentNote` must not change a picture element's rendered size when
  committing a move. Committing a moved element should translate it, never
  rescale it.
- `modifyElements` on a picture element should be able to update its
  `rect` (size/position), or the docs should state explicitly that it
  cannot and that re-insertion is the only way to resize a picture.
- Clarify, for picture elements specifically, the full lifecycle of
  `picture.rect` across insert → move → `saveCurrentNote` → `getElements`,
  since the value we read back disagrees with what we inserted in both
  size and (pre-save) position.

**Related**: builds on the lasso-vs-`saveCurrentNote` interaction already
noted under "Documentation gap: cache vs file APIs", and the stale
`getLassoElements` `picture.rect` entry in SDK_DOC.md.
