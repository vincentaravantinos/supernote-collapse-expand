# Process stack

## Frame 1
- Process: Change Request (CR-002) › Feature › Implementation
- Step: 5 — Validate the implementation
- Role: Test Manager
- Context: All 13 PLAN.md steps implemented (permission gates on all 5
  operations + the tap-shortcut, unified into `ensureAllPermissions()`,
  `FILE:DELETE` dropped as unneeded, per-permission dialog descriptions).
  Validation Part A (permission dialogs, denial handling, message,
  re-ask) fully passed — confirms B-015's fix. Part B (Collapse→Expand
  round trip) surfaced B-016: `userData` doesn't survive a round trip
  through any SDK read API on this firmware (Chauvet 2.26.40/3.29.43) —
  an external SDK bug, unrelated to CR-002's own code, already
  reported and reconfirming an earlier FEEDBACK.md entry. Reported to
  Ratta: https://www.reddit.com/r/Supernote_dev/comments/1w44uvs/bug_userdata_never_returned_by/
  Paused at the user's explicit request until Ratta ships a fix.
- Resume: Once Ratta ships a fix (watch the Reddit thread / release
  notes), rebuild, redeploy, and continue Implementation step 5 (Test
  Manager) from Part B of the validation script (in `PLAN.md`'s header
  and `BUGS/B-016.md`). No further code changes expected for B-016
  itself — just re-validation. `DEBUG` is back to `false`; flip it to
  reproduce the B-016-PROBE trace again if needed without
  re-instrumenting.
