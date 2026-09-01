# PLAN.md — CR-002: Declare plugin permissions

**PAUSED 2026-09-01.** All 13 steps below are implemented. On-device
validation Part A (permission dialogs, denial, re-ask, messages) passed.
Part B (Collapse→Expand round trip) surfaced B-016 — an external SDK bug
(`userData` doesn't survive a round trip through any read API on this
firmware), unrelated to this CR's own code, reported to Ratta:
https://www.reddit.com/r/Supernote_dev/comments/1w44uvs/bug_userdata_never_returned_by/.
Paused at the user's request until Ratta ships a fix. Resume: rebuild,
redeploy, continue Implementation step 5 (Test Manager) from Part B.
Nothing here is expected to need further code changes for B-016 itself —
just re-validation once the SDK is fixed. See `BUGS/B-016.md`.

Origin: `CRS/CR-002.md`, escalated to Feature. Implements SPEC.md
REQ-010–110 ("## Permissions" section).

## Design summary

- One shared helper, `ensurePermissions()`, called at the top of each
  operation entry point (after that function's own pre-existing "nothing
  to do" guards, before its first read/write) — mirrors `scribble`'s
  lazy, per-use pattern, generalized to collapse_expand's multi-permission,
  multi-operation surface.
- Per-operation permission sets (static call-site mapping — confirm each
  on-device in step 4/5, adjust if an error code shows a mismatch):
  - Collapse: READ, WRITE, DELETE
  - Expand: READ, WRITE
  - Recollapse: READ, WRITE, DELETE
  - Name/Rename: READ (before the confirm dialog, since its wording
    needs `getElements`) — then WRITE, DELETE (after the user confirms)
  - Icon-drag live redraw: READ, WRITE, DELETE
  - Background page-reading (tap-shortcut support): READ only, requested
    once at plugin activation (`index.js`'s existing fire-and-forget
    warm-up IIFE) — not re-requested per tap. "Ask again" (REQ-040) for
    this one means "next plugin activation," not "next tap" — re-asking
    on every qualifying tap would contradict REQ-020's "degrades
    silently" and would be a UX disaster (a system dialog on every
    touch). Documented here since it's a judgment call, not spelled out
    in SPEC.md itself.
- Denials never persist in our own cache — only grants do (in-memory
  `Set`, per plugin activation). This is what makes REQ-040 (ask again)
  correct by construction: a decline just isn't cached, so the next call
  to `ensurePermissions` re-checks `hasPermission` / re-prompts.
- `hasPermission`'s exact return values for an "always" grant are
  undocumented (only `requestPermission`'s 0/1/2 are confirmed in
  SDK_DOC.md) — treat any non-zero `hasPermission` result as granted
  (not just `=== 1`) to avoid a spurious re-prompt if it turns out to
  return 2 for "always". Confirm on-device in step 4/5.
- Name/Rename's WRITE+DELETE denial (post-confirm) must **not** fall
  back to Expand (`handleNameAction`'s existing `return true` path) —
  that fallback exists for "user declined the rename itself," a
  different case from "user confirmed, but permission was denied."
  Falling back would also change the page (an Expand), violating
  REQ-070. Both new denial paths return `false` (abort, no fallback,
  page unchanged).

## Files

### `src/utils/permissions.ts` (new)

`ensurePermissions(names: string[], message: string, opts?: { silent?: boolean }): Promise<boolean>`

- For each name: skip if already in the in-memory `GRANTED` set. Else
  `hasPermission` (non-zero → granted, add to set, continue). Else
  `requestPermission(name, message)` (result 1 or 2 → granted, add to
  set, continue).
- On the first name that isn't granted (denied, or the check/request
  itself threw): if `!opts.silent`, `alert(message)`. Return `false`
  immediately — don't request the remaining names (REQ-070/090's "page
  unchanged" needs the whole operation to abort, not a partial
  permission set).
- Return `true` once every name is granted.

### `src/constants.ts`

Add `PERM_FILE_READ`, `PERM_FILE_WRITE`, `PERM_FILE_DELETE` (the
`plugin.permission.FILE:*` strings), next to the other plugin-identity
constants.

### `PluginConfig.json`

Add `"uses-permissions": ["plugin.permission.FILE:READ",
"plugin.permission.FILE:WRITE", "plugin.permission.FILE:DELETE"]` —
declaring costs nothing (no dialog); omitting makes `requestPermission`
throw (SDK_DOC.md).

### `index.js`

In the existing fire-and-forget warm-up IIFE (lines ~74-85), call
`ensurePermissions([PERM_FILE_READ], <background message>, { silent:
true })` before `rehydrateExpandedRegistry(...)`. Implements REQ-010/020.
Skip `rehydrateExpandedRegistry` on denial (it would just no-op via
empty `getElements` today anyway, per SDK_DOC.md — skipping is clearer
than calling it knowing it can't do anything).

### `src/logic/collapseAction.ts` — `collapseAction()`

Gate `[READ, WRITE, DELETE]` right after the existing "Please make a
selection first" guard, before the per-element serialization loop
(which needs READ via `getPageSize`).

### `src/logic/expandAction.ts` — `expandSections()`

Gate `[READ, WRITE]` right after the existing `targets.length === 0`
guard, before `saveCurrentNote`/the `expandOne` loop.

### `src/logic/recollapseAction.ts` — `recollapseSections()`

Gate `[READ, WRITE, DELETE]` right after the existing `sectionIds.length
=== 0` guard, before `saveCurrentNote`/`getPageSize`.

### `src/logic/nameAction.ts` — `handleNameAction()`

- Gate `[READ]` right after the existing `strokeCandidates.length === 0`
  guard, before `saveCurrentNote`/`getElements` (needed to compute the
  confirm dialog's Set/Replace wording). On denial: `return false` (not
  `true` — this is a real rename attempt, not "nothing to rename").
- Gate `[WRITE, DELETE]` right after `if (!confirmRes) return true;`,
  before the serialize/insert/delete steps. On denial: `return false`.

### `src/logic/iconMoveRedraw.ts` — `redrawSectionBox()`

Gate `[READ, WRITE, DELETE]` right after the existing `if (!entry)
return;` guard, before `saveCurrentNote`/`getElements`. On denial:
`return` (same graceful-degradation the SPEC already documents for a
missed live redraw — content stays correctly recoverable via a real
Recollapse/Expand).

## Steps

1. [x] `src/utils/permissions.ts` — new helper.
2. [x] `src/constants.ts` — permission name constants.
3. [x] `PluginConfig.json` — `uses-permissions`.
4. [x] `index.js` — background READ gate in the init warm-up.
5. [x] `collapseAction.ts` gate.
6. [x] `expandAction.ts` gate.
7. [x] `recollapseAction.ts` gate.
8. [x] `nameAction.ts` two gates.
9. [x] `iconMoveRedraw.ts` gate.
10. [x] B-015 fix: reverted `index.js`'s init-time READ request (silently
    skipped at install time — see DIAGNOSTIC.md); added a run-once
    permission gate in `iconTapToggle.ts`'s `handleTap` instead (SPEC.md
    REQ-090/100/110).
13. [x] Dropped `FILE:DELETE` entirely (`PluginConfig.json`, `constants.ts`,
    `permissions.ts`) — per official docs
    (docs.supernote.com/en/plugin-base/permission, "Permission
    Dependencies"), `deleteElements`/`deletePageElements` are validated
    against `FILE:WRITE`, not a separate delete permission; `FILE:DELETE`
    is for file-level deletion, which this plugin never does. Only
    READ+WRITE requested now. SDK_DOC.md's "Runtime permissions" section
    updated with this pitfall (symlinked, separate commit).
12. [x] B-015 fix: `ensurePermissions` no longer pre-checks `hasPermission`
    (its return shape is unconfirmed and was observed always-truthy) —
    calls `requestPermission` unconditionally for anything not yet
    cached, trusting only its documented 0/1/2 result. Also gave each of
    the 3 permissions its own dialog description (was one generic
    string for all three) — DELETE's spells out it only removes strokes
    from the open note, never a file, per user feedback during
    validation.
11. [x] Simplified to "ask everything upfront": added `ensureAllPermissions()`
    to `permissions.ts`; every gate (collapse/expand/recollapse/rename/
    icon-drag/tap) now requests the full read+write+delete set instead
    of a per-operation minimal subset — first interaction of any kind
    resolves everything at once, later gates become no-ops via the
    shared grant cache. `nameAction.ts`'s two-stage gate collapsed into
    one upfront call. SPEC.md's Permissions intro + REQ-090/100/110
    updated to say "every permission" instead of "read permission."
