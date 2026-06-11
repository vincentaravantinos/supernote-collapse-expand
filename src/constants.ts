export const LOG = '[CollapseExpand]';

// Gates the PERF / SIZE / per-action diagnostic logs. Errors (`console.error`)
// and user-facing `alert`s are never gated. Flip on while developing.
export const DEBUG = false;
export function dlog(...args: any[]): void {
  if (DEBUG) console.log(...args);
}

// Logged at each action start to confirm which build is actually live: pushing a
// new .snplg doesn't always replace the running one. Bump per deploy.
export const BUILD_TAG = 'r59-recollapse-perf';

export const ICON_SIZE = 50; // px
// Padding around a section's content bbox to form its zone (mask + outline).
export const ZONE_MARGIN = 20;
// The icon is a TEXT glyph, not a picture: picture inserts triggered an SDK
// bridge desync that made insertElements silently no-op.
export const ICON_GLYPH = '⊕';
export const ICON_FONT_SIZE = 40;
export const SCHEMA_VERSION = 2;
export const CE_PLUG_PREFIX = 'CE_PLUG:';
export const CE_PART_PREFIX = 'CE_PART:';
export const CE_MASK_PREFIX = 'CE_MASK:';
// Boundary outline, tagged apart from the fill rings (CE_MASK) so the live
// icon-move redraw can move just the outline without re-stacking the fill.
export const CE_FRAME_PREFIX = 'CE_FRAME:';
// Max serialized section payload in the icon's userData. Measured safe: the
// .note format persists a 425 KB single-element userData intact, well under the
// ~1 MB binder transaction limit for insertElements.
export const MAX_USERDATA_BYTES = 512 * 1024;

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
