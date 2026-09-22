# Process stack

## Frame 1
- Process: Bug investigation
- Step: 2 — Report and ask
- Role: Triage Engineer
- Context: B-019 (dragging a natively-created, untracked link into an
  already-expanded section, then dragging the icon again, landed on
  page -1 and lost the link). Quick-guess hypothesis recorded in
  `BUGS/B-019.md` (untagged content + a numInPage shift from deleting
  the old mask/frame). Not yet confirmed via code trace or on-device
  repro. Interrupted here because the user wanted to first clarify the
  expected "absorb" semantics that this bug's repro scenario touches
  on, before continuing to chase the crash itself.
- Resume: Once the CR for absorb-semantics clarification is done, come
  back to B-019 step 2 — either trace the code first or reproduce
  directly on-device, per the user's choice (not yet made).
