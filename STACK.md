# Process stack

## Frame 1
- Process: Release
- Step: 3 (coherence review) done and all findings addressed (DEBUG hygiene, dead code removed, BUILD_TAG reset, kind:'section'->'plug' rename, tap-gesture dedup); about to start step 4 (duplication audit)
- Role: Architect (next step)
- Context: Steps 1-2 done and reported. Step 3 fully wrapped, including the user's on-device sanity check. Detoured to fix B-004 (closed, confirmed), B-011 (closed, confirmed — content-shift mechanism added), and log B-012 (deferred, not investigated). `DEBUG` is `false` again (was toggled on/off twice during B-011's diagnosis).
- Resume: Continue with step 4 (duplication audit, Architect) — scan for duplicated/near-duplicated logic beyond what the coherence review already caught.
