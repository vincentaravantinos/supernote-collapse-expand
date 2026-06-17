# Changes

## Unreleased

- Safety: collapse / expand / recollapse and the finger-tap shortcut now detect
  landscape mode and show a brief notice instead of running. In landscape the
  Supernote renders a split half-page where the lasso pipeline can hang
  indefinitely, so the plugin bails out early rather than risk freezing.

## 1.0.1

- Feature: a single **finger** tap directly on a section's "+" icon now
  toggles it — collapsed expands, expanded recollapses — without needing to
  lasso it and press the plugin button. Pen taps are unaffected (they draw
  ink as normal).

## 1.0.0

- Crash-safety: collapse, recollapse, and the live icon-move redraw now always
  create the new durable copy of a section's content (icon `userData` or
  on-page elements) and confirm it succeeded *before* deleting the old one, so a
  crash mid-operation can no longer lose content. Collapse also no longer deletes
  pictures/titles in the selection — they're left on the page, per spec. The
  busy guard now self-heals (after ~90s) if a crash leaves it stuck, instead of
  relying on a timer that may never fire. A failed expand or recollapse now shows
  a clear alert instead of failing silently.

- Known limitation (documented): a typed **text box** in a collapsed selection is
  preserved but, once expanded, is hidden behind the section's white area. This is
  a Supernote rendering behaviour — the device always draws text boxes beneath
  handwriting/shapes, so the mask sits on top of them — and can't be fixed from the
  plugin. Handwriting is unaffected. (See README + SDK_DOC.md.)

- Performance: expand and recollapse are markedly faster on pages with many
  strokes. The plugin no longer reads the whole page (which marshals every stroke
  across the bridge, ~7x more costly than it needs to be) when it only needs the
  section's own elements. Removed a redundant full-page read inside the section's
  userData write; expand now uses a lightweight num-list lookup plus a single
  icon fetch; recollapse fetches just the section's own parts/masks plus any
  newly-drawn strokes. On a ~230-stroke page, expand dropped from ~16s to ~8s and
  recollapse's page read from ~4s to ~1.2s. (The remaining time is the SDK's
  per-write file cost, which scales with total page size and isn't avoidable from
  the plugin.)

- Docs: added a **user guide** (now the project `README.md`) covering the
  collapse / expand / recollapse actions, multi-section selections, resizing or
  relocating a section by dragging its `+` icon, adding content to an expanded
  section, and the persistence / single-page / no-overlap limits. (Replaces the
  default React Native boilerplate README.)

- Feature: a **"working" indicator** now appears during slow operations
  (collapse / expand / recollapse, and the live icon-move redraw), so the plugin
  no longer looks frozen on a large note. It's a small card centered on the page
  (the rest of the page stays visible) shown while the operation runs and removed
  when it finishes.

- Fix: **moving the `+` icon while expanded now reliably redraws the section.**
  The redraw was driven by a timer that, it turned out, never fired while the
  plugin was idle (the host doesn't pump the JS event loop at rest), so after the
  pen lifted nothing happened — it only ever worked when stray touch events
  happened to wake the loop, which is why it was intermittent. The redraw now
  runs directly when you lift the icon. The icon's grab area was also widened so
  edge-grabs register.

- Feature: recollapse now **absorbs strokes (and text/shapes) drawn on top of an
  expanded section**, so they collapse with it and reappear on the next expand
  instead of being left orphaned on the page (fulfils the SPEC "Recollapse"
  requirement that had been disabled). Pre-existing content under the section
  stays put, and new strokes drawn outside the section are left alone. Done
  without the lasso read that previously caused the sync issue.

- Feature: while a section is expanded, dragging its `+` icon now **redraws the
  whole section live** (the moment you release) — white fill, outline, and the
  strokes — at the new stretched area, so you see the final result without a
  recollapse → expand round-trip. Driven by the SDK motion listener. Because it
  rebuilds the strokes each drag (needed to keep them above the fresh fill), it's
  noticeably slower than a normal pan; it's meant for the occasional reposition,
  not constant dragging.

- Behavior: **moving the `+` icon while a section is expanded now reshapes the
  section's area** instead of dragging the whole section along. On the next
  expand the restored content stays where it is and the zone (mask + outline)
  stretches so the icon sits right at the area's edge — drag the icon to the
  bottom-right and it ends up at the area's bottom-right; drag it far away and the
  section becomes a large, mostly-empty area. Moving the icon **while collapsed**
  still relocates the whole section.

- Behavior: a section's zone (white mask fill + boundary outline) is now defined
  by the **bounding box of its content + a small margin**, computed the same way
  at the initial collapse and at every recollapse — instead of the user's lasso
  rect. So the zone hugs the actual strokes (a loose lasso no longer leaves a big
  empty frame) and **adapts when a stroke is moved while expanded**. (If content
  is moved up/left past the `+` icon the zone currently extends toward the icon;
  auto-shifting the icon to stay clear is a planned follow-up.)

- Visuals: an expanded section is now marked by a **thin rectangle outline** at
  its boundary, the **mask fill is white** (blends with the page so the area
  reads as blank inside the frame) instead of gray, and the **`+` icon sits a
  little further up-left** so it no longer overlaps the frame. (The outline is
  solid, not dotted — the SDK has no dashed-line geometry.) The icon-placement
  change applies to newly collapsed sections.

- Feature: one button press can now **expand several collapsed sections at
  once** — lasso multiple `+` icons (optionally with other content) and they all
  expand in a single screen refresh. Any other selected strokes are left in
  place. (Recollapse keeps priority: a selection mixing an expanded section with
  collapsed icons recollapses the expanded one(s) that press.)

- Feature: recollapse can now be triggered by lassoing **any element of an
  expanded section** — its restored content or the mask covering it — not just
  the `+` icon. If the selection spans several expanded sections, all of them
  recollapse in a single press (and a single screen refresh). Recollapse takes
  priority: a selection mixing an expanded section with a collapsed icon
  recollapses the expanded one(s) and leaves the rest for that press.

- Feature: handwritten ("stroke") links now survive collapse → expand →
  recollapse as **working links** (tappable, jump to their target), not just
  their bare strokes. A stroke link references its member strokes by page
  number, which change on re-insert, so we persist *which* strokes are members
  (as indexes into the section, not page nums) and, on expand, re-insert the
  members and recover their fresh nums to rebuild the link. Expand of a section
  containing a stroke link costs one extra screen refresh per link (the SDK only
  reveals re-inserted elements' page nums after a `reloadFile`). Known
  limitation: the device recomputes a stroke link's clickable area from its
  strokes and ignores the area we pass, so a re-inserted link's area is the
  strokes' tight bounding box rather than the slightly wider area an
  interactively-drawn link reserves for its auto-icon (reported to Ratta on
  r/Supernote_dev).

- Fix: geometry-only selections can now be collapsed. The lasso button's
  `editDataTypes` listed stroke/title/image/text-box/link but omitted geometry
  (`5`), so the Collapse / Expand button was greyed out for selections
  containing only shapes — even though geometry was already serialized. Added
  `5`.

- Fix: the core "the operation reports success but nothing happens" failure
  (and crashes on large notes). The open note renders a *cached* copy of the
  `.note` file while plugin writes (`insertElements`/`deleteElements`) go to the
  *real* file, and the two are synced asynchronously. We now refresh the
  displayed copy with `reloadFile` after a write, and no longer call
  `saveCurrentNote` right after one (which was overwriting the real file with
  the stale cached copy and silently discarding the write). Root cause
  confirmed by the Supernote developer on r/Supernote_dev.

- Fix: moving the `+` icon and then expanding no longer double-inserts the
  content or loses the expanded state (which compounded and corrupted the
  section over repeated cycles). The section state is now written to the icon
  resolved fresh from `getElements`, not the stale lassoed element whose
  identity goes stale after a move.

- Fix: moving the `+` icon *while the section is expanded* no longer shifts the
  restored strokes out of place on the next expand. Recollapse now keeps the
  expand-time anchor instead of overwriting it with the icon's post-move
  position, so the content correctly follows the icon.

- Change: the `+` icon is now placed half an icon-size above-and-left of the
  selection (clamped at the page edge), so when the section is expanded the icon
  sits clear of the restored content and stays easy to select.

- Change: larger selections can now be collapsed — the serialized-content size
  limit was raised from 48 KB to 512 KB (the old value was an arbitrary guess;
  the note format stores far more), so realistic dense selections fit.

- Change: stroke links (handwriting recognized into a link) are skipped when
  collapsing — their underlying-stroke references can't survive a collapse
  round-trip and triggered an SDK error that could hang the expand. The strokes
  themselves still collapse; ordinary text links collapse fine.

- Fix: the plugin button can no longer get permanently stuck if an SDK call
  hangs — a watchdog releases the re-entrancy guard after 60s. Tapping the
  button while an operation is still running now shows a brief "still busy"
  notice instead of silently doing nothing.

- Fix: collapse/expand/recollapse now dismiss the lasso selection
  (`setLassoBoxState(2)`) instead of leaving it dangling. This removes the
  collapse flicker and, more importantly, fixes the cumulative failure where
  `insertElements`/`deleteElements` would silently stop taking effect after a
  number of operations (icon not appearing, recollapse leaving content on the
  page) — a left-open lasso kept the note app's trail bookkeeping
  inconsistent. Also fixes recollapse when the section overlaps pre-existing
  strokes, by closing the programmatic read-lasso before the file mutations.

- Change: the collapsed-section icon is now a text glyph (⊕) instead of a
  bundled picture element. On the current beta firmware, picture inserts
  triggered an SDK bridge desync that made `insertElements` silently no-op
  (collapse deleted strokes but produced no icon). Switching the icon to a
  TEXT element dodges that, and removes the whole class of picture-element
  workarounds: the `picturePath`/1211 re-anchor in `writeSection`, the
  `iconShrinkWorkaround` (moved pictures rescaled to ~14×14), and the
  stale-lasso-rect handling. Icon position is read from `textBox.textRect`.

- Fix: expanding (or recollapsing) a section after moving its `+` icon now
  restores the content at the icon's new location instead of its original
  one. The icon's current position is read from `getElements` (matched by
  section id) rather than from the lassoed element, which reports a stale
  pre-move rect. See SDK_DOC.md.

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