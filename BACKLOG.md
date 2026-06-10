# Backlog

Open feature requests and deferred items. Worked per the workflows in
`AGENT.md` (features → architect-challenge then implementation; the
geometry item below is a bugfix-workflow item). Remove an item once the
user confirms it's done.

1. ISSUE: recollapse should absorb new strokes drawn on top of the expanded section into the section, so they reappear on the next expand (required by SPEC.md "Recollapse"). Currently DISABLED (`ABSORB_STROKES_VIA_LASSO = false` in `recollapseAction.ts`): it was turned off during the cached/real sync investigation because the mid-operation `lassoElements(contentRect)` read fed the desync. So right now strokes drawn on an expanded section stay orphaned on the page after recollapse — a spec divergence. Either re-enable it safely now that we have the reloadFile model (the absorb read-lasso needs careful handling + dismissal so it doesn't re-introduce the desync), or decide absorb isn't worth the risk and update SPEC.md to drop the requirement. Bugfix/spec-alignment item — diagnose/validate on-device.