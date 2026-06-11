# Supernote Plugin SDK — Reference Supplement

A complement to the official plugin-SDK docs (https://docs.supernote.com/en),
covering behavior they don't document or leave ambiguous. Written for plugin
authors using the API: each section states how an API behaves and how to use it
correctly. Keep entries factual and concise — describe the API, not how we
discovered it.

---

## Picture elements: `picture.picturePath` is not stable across a round-trip

When you insert a picture element you supply a real on-disk path (e.g. a bundled
asset under your plugin directory). After the element is saved and read back via
`getElements` / `getLassoElements`, its `picture.picturePath` is replaced with an
SDK-internal cache reference of the form
`/storage/emulated/0/.data/plugin/<millis>.png`. That cache path often does not
exist on disk even though the picture renders correctly (the image bytes are
stored with the note).

- Treat `picture.picturePath` from a read-back element as opaque; do not rely on
  it pointing to a readable file.
- `modifyElements` on a picture reads the source image from `picture.picturePath`
  and fails with **error 1211** ("PNG file does not exist. Cannot call the
  API!") if it doesn't resolve to a readable file — even when you only intend to
  change `userData`. Before calling `modifyElements`, re-assign
  `picture.picturePath` to a path you control (e.g. re-resolve the bundled asset
  via `PluginManager.getPluginDirPath()`).

The cache directory `/storage/emulated/0/.data/plugin/` accumulates one
`<millis>.png` per picture insert and is not cleaned up (files persist after the
note is deleted). This is device-side; a plugin cannot manage it.

---

## Lassoed elements are stale after a move — read and write via `getElements`

The elements from `getLassoElements` (the user's selection passed to your button
handler) can be a **stale snapshot** of an element that has been moved:

- **Position is stale.** A moved picture's `picture.rect` from `getLassoElements`
  is the pre-move position. (For pictures no other position field is populated:
  top-level `rect`, `x/y`, `boundingRect` are absent; `maxX/maxY` are page EMR
  dimensions, not a position.) `getElements` returns the current position.
- **Identity is stale.** The lassoed element's `numInPage` can also be stale, so
  `modifyElements([lassoedElement])` targets the wrong slot and **silently fails
  to persist** while still reporting success.

Use the lassoed element only to identify which element/section the user selected.
For both reads and writes, resolve the element fresh from `getElements` (matched
by a stable key you control, e.g. your own `userData` id), after `saveCurrentNote`
so the move is reflected.

---

## `modifyElements` cannot resize a picture; a committed move shrinks it

- `insertElements` honors a picture's `rect` (size and position).
- `modifyElements` updates `userData` but does **not** apply a picture's `rect`;
  it cannot resize a picture.
- Committing a *move* of a picture — via any save, including the app's autosave
  when the user taps away after dragging — rescales it to ~14×14 px regardless of
  its original size. Position is preserved; size is corrupted. Reproducible with
  no plugin involved.

To set or restore a picture's size, delete and re-insert it.

---

## Always dismiss the lasso before returning — `setLassoBoxState(2)`

`setLassoBoxState(state)`: `0` = show; `1` = hide the menu but keep the selection;
`2` = commit the selection back to the page and release it.

Any operation with an active lasso — the user's selection that triggered your
button, or a `lassoElements(rect)` you opened yourself — must close it with
`setLassoBoxState(2)` before the handler returns, and before any file-level
mutation. There is a single global lasso selection, so one `setLassoBoxState(2)`
closes whatever is open. Closing does not undo committed inserts/deletes.

Leaving a lasso open across a mutation (`insertElements` / `deleteElements` /
`saveCurrentNote`) makes the host's plugin-facing element list drift from the note
model. The drift is cumulative and silent: mutations begin returning
`success: true` while doing nothing, until the note app is restarted.

```
// Mutating the user's selection: mutate, then close at the end.
deleteLassoElements();
insertElements([...]);
setLassoBoxState(2);

// Opening a lasso only to read: close immediately after reading,
// before any mutation.
lassoElements(rect);
const els = getLassoElements();
setLassoBoxState(2);
insertElements([...]);
```

`setLassoBoxState(2)` does not replace `reloadFile()` after an insert (see below).

---

## The open note renders a cached copy; surface writes with `reloadFile`

An open note does not render its real `.note` file directly — it renders a
**cached copy**. `insertElements` / `deleteElements` write the **real** file; the
host then syncs real→cached **asynchronously**, and that sync may not have
completed when the write call returns.

- **Reads of the open note come from the cached copy.** `getElements`,
  `getElementNumList`, and the other element reads on the currently-open note read
  the cached copy, so immediately after a write they can return stale data —
  inserts not yet visible, deletes still present — while still reporting success.
  The staleness can persist indefinitely, not just briefly. A before/after
  `getElementNumList` diff to detect just-inserted elements therefore returns
  nothing unless you `reloadFile` between the write and the second read.
- **Do not `saveCurrentNote` immediately after a write.** `saveCurrentNote` writes
  the cached copy back to the real file; if the real→cached sync hasn't landed it
  overwrites the real file with the stale cache and discards your write. If you
  need `saveCurrentNote` to flush user strokes, call it *before* the plugin write.
- **Use `reloadFile()` to surface a write.** It reloads the cached copy from the
  real file, deterministically reflecting the write.

```
insertElements([...]);   // writes the real file
// no saveCurrentNote here
reloadFile();            // cached := real; the change now renders
```

`modifyElements` can return **error 102** ("This app is not allowed to use this
API. Please call a different API.") when the note is not in a stable editable
state (mid-reload, just after a crash, during a hung operation). Treat a stable,
loaded note as a precondition for `modifyElements`.

---

## Stroke links (`Link.category = 1`)

A stroke (handwritten) link is a `Link` element with `category = 1` whose
`controlTrailNums` lists the `numInPage` of the strokes that form the link.
When recreating one with `insertElements`:

- `controlTrailNums` references strokes by page number, which change when the
  strokes are re-inserted. So re-insert the member strokes, determine their new
  `numInPage`, and set `controlTrailNums` to those. `controlTrailNums` is treated
  as a set — order is irrelevant.
- Empty `controlTrailNums` → **error 510** ("Stroke link has no control stroke
  numbers. Cannot call the API.").
- Empty/zero area rect → **error 509** ("Invalid link area. Please set it
  again!"); you must pass a non-zero `X/Y/width/height`.
- For `category = 1` the SDK **ignores the passed area and recomputes it** from
  `controlTrailNums` (the strokes' bounding box plus a few px of padding). The
  rect you pass is only a non-empty placeholder to clear validation; the final
  area is device-controlled and cannot be widened from the plugin. (An
  interactively-created stroke link reserves extra room for its auto-added link
  icon; a re-inserted one gets the tight bounding box, so the icon falls outside
  the clickable area.) Text links (`category = 0`) do honor their passed rect.

---

## Geometry elements

- `Geometry.type` is one of `straightLine`, `GEO_circle`, `GEO_ellipse`,
  `GEO_polygon`. A `GEO_polygon` renders an **outline** through its `points`
  (not a filled shape) — to fake a filled rectangle, stack concentric polygon
  rings with a thick `penWidth`.
- `penType` only has **solid** pens (10 = fineliner, 1 = pressure, 11 = marker,
  14 = calligraphy). There is **no dashed/dotted line style** for geometry; a
  dashed border exists only for link elements (`Link.style = 2`) and the lasso
  box. A dotted outline must be faked from many short segments.
- `penWidth` scales roughly 100 units per on-screen px (≈18000 renders a ~180px
  band); `penColor` accepts only specific palette values (e.g. `0x00` black,
  `0x9D` dark gray, `0xC9` light gray, `0xFE` white). `penType` 0 is rejected.
- `points` are Android screen coordinates (relative to top-left), not EMR.

---

## Plugin event listeners (`PluginManager`)

For reacting to user input outside the plugin button:

- **`registerEventListener(EventType.PEN_UP, registerType, listener)`** — fires
  when the pen lifts after **drawing**; `listener.onMsg(data)` receives the
  element(s) just drawn. It does **not** fire when the user *moves* a selection
  (drags an already-selected element), so it can't detect an element move. The
  SDK comment notes only `event_pen_up` is supported via this call.
- **`registerMotionListener(registerType, listener)`** — raw touch. `onMsg(m)`
  receives a `MotionEvent`: `action` (0=DOWN, 1=UP, 2=MOVE, 3=CANCEL), primary
  `x`/`y`, `pointers[]` (each `x/y/pressure/toolType/pointerId`), `pointerCount`,
  `toolType` (1=finger, 2=pen), `downTime`/`eventTime`. It **does** fire
  throughout a selection-drag, so `ACTION_UP` is a usable "gesture ended" signal.
  Caveats: it fires for *every* touch (draw/scroll/tap), `ACTION_MOVE` streams at
  high frequency (cheap to ignore with an early `action` check), and the payload
  carries **no element identity** — only coordinates. To know *what* moved you
  must correlate the touch position with element rects yourself (and the `UP`
  event carries `downTime` but not the down coordinates, so capture the start
  point on `ACTION_DOWN` if you need it).
- `registerType`: 0 = always first, 1 = normal, 2 = always last (ordering when
  multiple plugins register the same event).

---

## Beyond the JS bridge: native host API and background execution

- **`HostCommonAPI`** (the Java host surface, in
  `node_modules/sn-plugin-lib/android/.../api/HostCommonAPI.java`) exposes the
  full element API — writes (`insertElements`, `modifyElements`, `deleteElements`,
  `replaceElements`, `insertGeometry`, `insertText`), reads (`getElements`,
  `getElement`, `getElementCounts`, `getElementNumList`, `getLastElement`), and
  `PluginAppAPI.readTrailsFromFile(path)` plus trail-cache access. Calling it from
  a native module bypasses the React Native JS↔native bridge, which is the main
  per-stroke cost of `points.size()` + `getRange()` (read) and `createElement` +
  `setRange` (write). The host-side commit/render still runs regardless of caller.
- **Background execution** is possible via React Native Headless JS or a Java
  background thread.
- **`getCacheElement` (PluginCommAPI)** exists but is undocumented; likely a
  cache-backed element read. Semantics unconfirmed — avoid until documented.
