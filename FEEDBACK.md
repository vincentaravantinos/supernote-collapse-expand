# Feedback for Ratta (r/Supernote_dev)

Terse, paste-ready notes for the plugin-preview thread.

---

Lasso-toolbar button label cannot reflect the current selection. Two gaps:

1. registerButton with an existing id and a new name does not relabel a lasso toolbar that is already open; the new name only shows on the next selection.
2. there is no event when a selection is made / the lasso menu opens (only event_pen_up, event_import_sticker, motion_event), and the button listener only fires on press.

expected: a way to set a button's label per selection - e.g. a selection-changed / menu-opening callback, or a setButtonLabel(id, name) that updates the open toolbar.
observed: the label is fixed once the toolbar opens, so a plugin can't show "Collapse" vs "Expand" vs "Recollapse" based on what's selected.
