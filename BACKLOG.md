# Backlog

Open feature requests and deferred items. Worked per the workflows in
`AGENT.md` (features → architect-challenge then implementation; the
geometry item below is a bugfix-workflow item). Remove an item once the
user confirms it's done.

1. give the user the ability to recollapse not just by lassoeing the icon but any element in the expanded section (only the ones from the original section, so that we can use the userdata to identify if it'S part of the section, let's not overdo it)
2. have the possibility to collapse multiple sections at once if multiple are selected
3. investigate the lasso button `editDataTypes` registration in `index.js` (currently `[0, 1, 2, 3, 4]`). A community plugin (prelude-rs_sn-align-plugin) reports the values are `0=stroke, 1=title, 2=image, 3=text-box, 4=link, 5=geometry`, and that omitting `5` greys the button out for pure-geometry selections. We serialize geometry, so a user lassoing only geometry may be unable to collapse it. Diagnose on-device (does the button actually grey out for a geometry-only selection?) before adding `5` — this is a bugfix-workflow item, not a silent patch.
