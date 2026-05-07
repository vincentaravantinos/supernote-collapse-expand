
# Backlog

1. give the user the ability to recollapse not just by lassoeing the icon but any element in the expanded section (only the ones from the original section, so that we can use the userdata to identify if it'S part of the section, let's not overdo it)
2. have the possibility to collapse multiple sections at once if multiple are selected

# Workflow for new features

For each feature request in the Backlog, act as follows:
1. first act as an architect who challenges the Product Owner from a technical perspective (ex. if you think that the requested feature has some corner case that make it hard to implement so you'd request some simplification)
2. if there is no particularly issue and you think the feature is doable, move to the workflow for implementation below
3. Once I confirm the feature as implemented, remove it from the backlog above

# Workflow for bug fixing

For every bug reported by the user, do the following:
1. Try a quick guess on the root cause by looking at the code. Keep it quick though I don't want you to use all tokens on some pure guesses.
2. In case this quick guess was successful: report it and ask for confirmation.
3. In case it was not successful: act as a triage engineer: instrument the code to find out more. Have in mind already that I will copy paste the trace as a result so it has to help you to root cause things.
4. Iterate until you have relative certainty on what is going on. 
5. Keep in mind that the API we are using for the Supernote is in beta so it might itself have bugs.
6. Whether you obtain the root cause as a result of a guess (step 2) or as a result of a deep root cause analysis (subsequent steps), act as an architect and come up with a plan to address that bug. Create the file PLAN.md accordingly (if the file is already there for an ongoing feature rename to avoid clashes).
7. Move to the workflow for implementation below 
8. When bug fix is confirmed by me always run a pass of cleaning up whatever instrumentation or code changes you did to do an experiment. I want a clean slate.

# Workflow for implementation

1. if there is no particularly issue and you think the feature is doable, create a plan of the implementation and store it in a file PLAN.md.
2. Make sure the plan is splitted in file-per-file changes, with a clear, small scope (ideally file-level, as little multi-file changes as possible)
3. Request a review of the plan.
4. Check that the plan is not recreating unnecessary logic or redundant steps with respect to the existing codebase.
5. If this changed the plan, ask for a review again.
6. Once approved, start with implementation, one step after the other. Ask for a review after each step.
7. Once a step is done, amend PLAN.md to mark the corresponding step as done - then re-read the plan and the next step before moving on. I want you to always get back to the plan as an "anchor" to avoid that you deviate.

# Steps independent of workflow

Once I confirm that a feature or bugfix is done:
1. remove the PLAN.md file
2. add a short summary of the change to CHANGES.md (I will use this for release notes)
3. if something on the way was discovered that needs to be a feedback to the Supernote developers (either bug fix or developper doc improvement), collect it in FEEDBACK.md

# General behavior

* SPEC.md is the source of truth for plugin behavior. Read it at the start of every task — feature, bugfix, or anything else — and treat its requirements (especially the persistence-across-power-cycle requirement) as hard constraints. If a task seems to violate the spec, flag it before implementing. If the spec needs to change to accommodate a task, update SPEC.md as part of the work and call out the change explicitly.
* For each new feature and for each step above, always come back to that file to make sure to remember the above.
* In case I forget a step and tell you to move on, remind me of it.
* At any time, in case you don't know for sure, rather admit it and come up with experiments (potentially including code instrumentation), rather than just guessing.
* Do all steps above separately so that you can always focus on one task and one task only.
* If, during a feature development, or after a fix attempt, it turns out the feature is not working as expected, switch automatically to the workflow for bugfixing. I tend to just move on and forget to do the basics.