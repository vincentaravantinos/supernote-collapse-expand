export const LOG = '[CollapseExpand]';

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
export const MAX_USERDATA_BYTES = 48 * 1024; // 48 KB limit

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
