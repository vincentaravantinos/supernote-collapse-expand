export const LOG = '[CollapseExpand]';

// Build stamp — logged at every action BEGIN so the trace tells us which build
// is actually live (force-stop doesn't always re-extract a new .snplg). BUMP
// THIS every deploy while debugging the reload, then confirm it in logcat.
export const BUILD_TAG = 'r12-drop-preserved';

export const ICON_SIZE = 50; // pixels
// The collapsed-section icon is a TEXT glyph (⊕ = U+2295 CIRCLED PLUS),
// not a picture element — picture inserts triggered an SDK bridge desync
// that made insertElements silently no-op. Text dodges that entire class.
export const ICON_GLYPH = '⊕';
export const ICON_FONT_SIZE = 40;
export const SCHEMA_VERSION = 2;
export const CE_PLUG_PREFIX = 'CE_PLUG:';
export const CE_PART_PREFIX = 'CE_PART:';
export const CE_MASK_PREFIX = 'CE_MASK:';
// Max serialized section payload stored in the icon's userData. The original
// 48 KB was an arbitrary day-one value — measured (2026-06-09): the .note format
// persists a 425 KB userData on a single element intact and a 223-stroke / 367 KB
// section round-trips through collapse→expand cleanly, so there is no ~64 KB
// ceiling. 512 KB stays well under the ~1 MB binder transaction limit for
// insertElements while comfortably allowing large selections. Compact stroke
// encoding (flat + delta) can raise the effective stroke count further.
export const MAX_USERDATA_BYTES = 512 * 1024; // measured-safe; was 48 KB

export const PLUGIN_BUTTON_NAME = 'Collapse / Expand';
export const PLUGIN_MENU_ID = 200;

export const ELEMENT_TYPES = {
  STROKE: 0,
  TITLE: 100,
  PICTURE: 200,
  TEXT: 500,
  TEXT_DIGEST_QUOTE: 501,
  TEXT_DIGEST_CREATE: 502,
  LINK: 600,
  GEO: 700,
};
