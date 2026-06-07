# API & Pattern Audit: supernote-collapse-expand

**Date**: 2026-06-07  
**Auditor**: Claude Code  
**Scope**: Compared against 28 community plugins listed in r/Supernote_dev "List of ALL Available Plugins" (post `1tibpxy`, u/theBlackOddity, updated 2026-06-06) and against `sn-plugin-lib` versions `0.1.34` (installed) and `0.1.43` (community latest).

**Key reference repos**: `taoist22/sn-restyle`, `prelude-rs/sn-align-plugin`, `guibor/supernote-shape-snap`, `j-raghavan/sn-mindmap`, `jpmoo/compass`, `taoist22/sn-list-sorter`, `apclark31/supernote-plugin-research`.

---

## Architecture Context

This plugin runs **headless** (`showType: 0`). No React view is opened; the button handler fires, modifies note elements, and returns. This is architecturally distinct from the majority of community plugins, which open a full-screen view (`showType: 1`). Several recommendations found in community code and in `apclark31`'s research notes explicitly apply only to full-screen plugins (e.g. "drop `reloadFile`, use `closePluginView` instead"). Those do **not** apply here. Every finding below takes the headless model into account.

---

## What the Plugin Gets Right

These patterns are validated against community code and are correct as-is.

**TEXT-glyph icon** (`⊕`, U+2295 as a `TYPE_TEXT` element) — storing section state as a TEXT element's `userData` is a solid, well-precedented pattern. `taoist22/sn-list-sorter` uses the same createElement(500) + insertElements + modifyElements + userData lifecycle.

**Heavy save → reload for headless** — calling `saveCurrentNote()` before each structural read and `reloadFile()` after each write is the correct idiom for a headless plugin. `taoist22/sn-restyle` documents the same save-before-read, reload-after-write cadence and explicitly notes it is needed in headless mode. The `apclark31` research suggesting intermediate saves are unnecessary applies only to full-screen plugins.

**`createElement` + field assignment** — using the SDK factory (`createElement(type)`) then assigning fields one by one is standard. All community plugins that create elements use this pattern.

**`numInPage` Z-order preservation** — recording `numInPage` when collapsing and restoring it on expand preserves drawing order. This is a non-obvious correctness property; no community plugin does anything equivalent, so this is genuinely novel and correct.

**userData for note-bound state** — storing section JSON in `CE_PLUG:` prefix on the icon element's `userData` is the right durability mechanism. It survives power-cycle and note movement (state follows the element). The `CE_PART:` / `CE_MASK:` tagging on restored elements for recollapse identification is also well-designed.

**`recycle` / `recycleAll` in `finally`** — `taoist22/sn-restyle` and others call `recycleAll` in a `finally` block. Our plugin calls `element.recycle()` in `finally` in `collapseAction` and `expandAction`. This is correct.

---

## Antipatterns and Gaps

Ranked roughly by risk / impact.

### ① Missing `setLassoBoxState` after lasso operations  
**Risk: HIGH — visual artifact / state corruption**

In `collapseAction.ts`, after `deleteLassoElements()`, the lasso box is never dismissed. The Supernote firmware leaves the lasso selection UI in an undefined state. `prelude-rs/sn-align-plugin`, `guibor/supernote-half-size`, and `guibor/supernote-shape-snap` all call `setLassoBoxState(2)` (commit + release + trigger native undo) or `setLassoBoxState(0)` (show) at the end of every lasso-mutating operation to cleanly close the selection.

`shape-snap`'s flash-free path is particularly instructive:
```
deleteLassoElements()
insertGeometry(geometry)       // re-inserts new shape
setLassoBoxState(2)            // commit, release, no reloadFile needed
```
No `reloadFile` is required when `setLassoBoxState(2)` is used. Our flow calls `saveCurrentNote` + `insertElements` but skips `setLassoBoxState`, leaving the lasso box dangling.

**Fix**: add `setLassoBoxState(2)` as the last call in `collapseAction` (after `insertElements` + `saveCurrentNote`). Investigate whether this also allows dropping the `reloadFile` call in `expandAction`/`recollapseAction` on-device.

---

### ② No re-entrancy guard on button listener  
**Risk: HIGH — state corruption if user double-taps**

`index.js` registers:
```js
registerButtonListener({ onButtonPress: event => { handleMainAction() } })
```
`handleMainAction` is `async`. The firmware can re-fire the button press while the first invocation is still awaiting SDK calls. A second concurrent invocation reads stale page state, races on `saveCurrentNote`, and can corrupt the section JSON.

`prelude-rs/sn-align-plugin` has an explicit boolean guard:
```js
let running = false;
onButtonPress: async () => {
  if (running) return;
  running = true;
  try { await doWork(); } finally { running = false; }
}
```

**Fix**: add a module-level `let isRunning = false` guard in `index.js` (or `src/index.ts`), wrapping `handleMainAction` invocation.

---

### ③ Excessive `saveCurrentNote` calls  
**Risk: MEDIUM — latency**

The current flow in `expandAction` and `recollapseAction` calls `saveCurrentNote` 2-3 times per operation: once before reading, once after each write batch. `apclark31`'s research (and `taoist22/sn-list-sorter`) show that a single `saveCurrentNote` at the start (to flush the native layer before a read) and a single save at the end are sufficient. The intermediate saves between `insertElements` → `modifyElements` in `expandAction` are unnecessary and add latency.

`apclark31` measured a 9-call flow at ~3 seconds and a 4-call flow at ~1 second on-device.

**Fix**: audit each operation and reduce to one pre-read save + one post-write save per logical operation.

---

### ④ Multiple `reloadFile` calls per operation  
**Risk: MEDIUM — latency, visual flash**

`expandAction.ts` calls `reloadFile()` once after `insertElements + saveCurrentNote` and would call it again after `writeSection`. Similarly `recollapseAction` calls `reloadFile` after `deleteElements + saveCurrentNote` and again after `writeSection`. A single `reloadFile` at the very end of the operation is sufficient.

Note: `reloadFile` is still required for headless plugins (it is the explicit refresh trigger). This is not a recommendation to remove it — only to call it once.

---

### ⑤ `buildLink` omits `controlTrailNums` and `page` — latent bug  
**Risk: MEDIUM — error 502 on expand**

In `src/utils/elementSerializer.ts` (around line 212–241), `buildLink` reconstructs the `element.link` object by direct assignment:
```ts
element.link = {
  category: data.category,
  rect: ...,
  style: ...,
  linkType: ...,
  destPath: ...,
  fontSize: ...,
  fullText: ...,
  showText: ...,
  italic: ...,
};
```
The `Link` model in `sn-plugin-lib` has two fields with non-trivial defaults:
- `page: number = 0`
- `controlTrailNums: number[] = []`

Both are absent from the assignment. `jpmoo/compass` (a link-heavy plugin) sets both explicitly. The SDK throws error 502 when `controlTrailNums` contains orphaned element references — the default `[]` prevents this. The missing `page` field may default to `undefined` rather than `0` depending on JS runtime behaviour.

**Fix**: add `page: data.destPage` (already serialized in `SerializedLink`) and `controlTrailNums: []` to the assignment in `buildLink`. Also confirm `SerializedLink.destPage` is populated on serialize.

---

### ⑥ No `clearElementCache()` after `getElements`  
**Risk: LOW-MEDIUM — stale reads in subsequent calls**

`expandAction.ts` and `recollapseAction.ts` call `getElements` to read current page state. `jpmoo/compass` and `taoist22/sn-restyle` call `clearElementCache()` after each `getElements` round-trip to prevent the SDK from returning cached (stale) data in subsequent calls.

Our `userDataManager.getCurrentIconRect` calls `getElements` but does not follow it with `clearElementCache()`.

**Fix**: add `await noteAPI.clearElementCache()` (or equivalent) after each `getElements` call in `userDataManager.ts`, `expandAction.ts`, and `recollapseAction.ts`.

---

### ⑦ Magic numbers for element types  
**Risk: LOW — readability / future proofing**

`src/constants.ts` defines element type constants as raw numbers (`500`, `700`, `0`, etc.) rather than using the enums exported by `sn-plugin-lib`:
```ts
// current
const TYPE_TEXT = 500;
// community standard (sn-mindmap, sn-restyle, compass)
import { Element } from 'sn-plugin-lib';
Element.TYPE_TEXT  // 500
Element.TYPE_GEO   // 700
Element.TYPE_STROKE // 0
```

`j-raghavan/sn-mindmap` imports `Element.TYPE_GEO` throughout instead of the raw `700`. This is cosmetic but aligns with community style.

**Fix**: import element type constants from `sn-plugin-lib` and remove the local re-declarations in `constants.ts`.

---

### ⑧ `alert()` for user feedback  
**Risk: LOW — non-standard UX**

Several call sites use `alert()` (React Native's global) to surface messages to the user. The community norm for status feedback in headless plugins is either silent operation or using the toast/notification APIs if available. `alert()` spawns a modal dialog that interrupts the writing flow. The visual disruption is more pronounced in a headless plugin because the user is in the middle of editing, not in a plugin view.

No community plugin examined uses `alert()`.

**Fix**: either remove non-critical alerts or replace with a lighter mechanism once one is identified on-device.

---

### ⑨ `sn-plugin-lib` version lag  
**Risk: LOW — missing newer APIs**

`package.json` declares `"sn-plugin-lib": "^0.1.19"` but the lockfile resolves to `0.1.34`. The community is on `0.1.43`. New APIs available in `0.1.43` but not `0.1.34`:

- `Geometry.showLassoAfterInsert: boolean` — set `true` to auto-lasso a newly inserted geometry without a separate `lassoElements(rect)` call
- `PluginNoteAPI.replaceElements(filePath, page, elements[])` — atomic full-page rewrite; some plugins use this to avoid the cumulative corruption risk of repeated `modifyElements` calls
- Additional `PointUtils` helpers

None of these are blockers for current functionality, but `replaceElements` is worth noting as a safer `modifyElements` alternative if corruption issues surface.

**Fix**: update `package.json` to `"sn-plugin-lib": "^0.1.43"` and run `npm install` to pick up the latest lockfile. Confirm no API regressions (the surface is additive-only between 0.1.34 and 0.1.43).

---

## Items Requiring On-Device Verification

These are areas where community practice differs from our implementation, but the difference may be justified by element type or device configuration. They need on-device testing to confirm.

**Coordinate space for synthesized shapes**  
Our plugin converts stroke points through `PointUtils.androidPoint2Emr` and rescales against `pageMaxX/maxX`. `guibor/supernote-shape-snap` inserts geometry (GEO elements) directly in Android pixel space without EMR conversion. `j-raghavan/sn-mindmap` avoids using `getElements` maxX/maxY entirely (uses a lasso round-trip for pixel extent instead). It is not clear whether the coordinate space convention differs between captured ink (STROKE elements) and synthesized shapes (GEO elements), or whether it is device-dependent. Instrument with coordinate logging before and after conversion to confirm strokes and geometry land where expected on an actual device.

**Cross-device canvas guard**  
`taoist22/sn-restyle` refuses to modify elements when the note's canvas size does not match the device's native canvas (e.g. a Manta-format note opened on an A5X). Our `pageMaxX/maxX` rescaling may partially handle this, but it was not designed as a cross-device guard. Confirm behavior when a note created on one device is edited on another with a different canvas size.

---

## SDK Quirks to Promote to SDK_DOC.md

The following were surfaced during audit (cross-referencing `apclark31/supernote-plugin-research`'s `PROGRESS.md` and community READMEs) and are not yet in our `SDK_DOC.md`:

- **Error 502** — thrown when a `Link` element's `controlTrailNums` array references element indices that no longer exist. Default to `[]` when constructing any Link element.
- **Error 904** — lasso context expires after `insertText` + save, or after page navigation. `deleteLassoElements` returns 904 in an expired context. Must not call lasso-context APIs after saving.
- **`replaceElements` adjacent-stroke shift** — some community notes report that `replaceElements` can shift strokes that are adjacent to (but not inside) the replaced element set. Unconfirmed; worth testing if we adopt `replaceElements`.
- **`setLassoBoxState` semantics** — state 0: show lasso, state 1: hide menu but keep selection, state 2: commit + release + trigger native undo. Using state 2 after a lasso mutation closes the selection cleanly and may eliminate the need for `reloadFile` in some flows.
- **`clearElementCache()` necessity** — subsequent `getElements` calls within the same plugin session may return cached (stale) data if `clearElementCache()` is not called between reads. Call it after every `getElements` round-trip.
- **Intermediate saves** — `saveCurrentNote` between `insertElements` and `modifyElements` within a single logical operation is not required. One pre-read save + one post-write save suffices. (Full-screen plugin finding from `apclark31`; validate on-device for headless.)

---

## Summary Table

| # | Finding | Risk | File(s) |
|---|---------|------|---------|
| ① | No `setLassoBoxState(2)` after lasso mutations | HIGH | `collapseAction.ts`, `expandAction.ts`, `recollapseAction.ts` |
| ② | No re-entrancy guard on button listener | HIGH | `index.js` |
| ③ | Excessive `saveCurrentNote` calls | MEDIUM | `expandAction.ts`, `recollapseAction.ts` |
| ④ | Multiple `reloadFile` calls per operation | MEDIUM | `expandAction.ts`, `recollapseAction.ts` |
| ⑤ | `buildLink` omits `controlTrailNums` + `page` (latent bug) | MEDIUM | `elementSerializer.ts` |
| ⑥ | No `clearElementCache()` after `getElements` | LOW-MED | `userDataManager.ts`, `expandAction.ts`, `recollapseAction.ts` |
| ⑦ | Magic numbers for element types | LOW | `constants.ts` |
| ⑧ | `alert()` for user feedback | LOW | multiple |
| ⑨ | `sn-plugin-lib` version lag (0.1.34 vs 0.1.43) | LOW | `package.json` |
| — | Coordinate space for synthesized shapes | VERIFY | `elementSerializer.ts`, `maskHelpers.ts` |
| — | Cross-device canvas guard | VERIFY | `expandAction.ts`, `recollapseAction.ts` |
