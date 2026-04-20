import { CollapsedElement } from '../model/types';
import { ELEMENT_TYPES } from '../constants';
import { PluginCommAPI, PluginNoteAPI } from 'sn-plugin-lib';

/**
 * Delta-encoding for point arrays.
 * First point is absolute {x, y}.
 * Subsequent points are {dx, dy} (integers).
 */
function encodePoints(points: any[]): any[] {
  if (!points || points.length === 0) return [];
  const encoded = [];
  encoded.push({ x: points[0].x, y: points[0].y });
  for (let i = 1; i < points.length; i++) {
    encoded.push({
      dx: Math.round(points[i].x - points[i - 1].x),
      dy: Math.round(points[i].y - points[i - 1].y),
    });
  }
  return encoded;
}

function decodePoints(encoded: any[]): any[] {
  if (!encoded || encoded.length === 0) return [];
  const decoded = [];
  let currentX = encoded[0].x;
  let currentY = encoded[0].y;
  decoded.push({ x: currentX, y: currentY });
  for (let i = 1; i < encoded.length; i++) {
    currentX += encoded[i].dx;
    currentY += encoded[i].dy;
    decoded.push({ x: currentX, y: currentY });
  }
  return decoded;
}

export function serializeElement(element: any): CollapsedElement | null {
  const data: any = {};

  if (element.type === ELEMENT_TYPES.STROKE) {
    data.points = encodePoints(element.points);
    data.penWidth = element.penWidth;
    data.penColor = element.penColor;
    data.penType = element.penType;
  } else if (element.type === ELEMENT_TYPES.GEO) {
    data.points = encodePoints(element.points);
    data.penWidth = element.penWidth;
    data.penColor = element.penColor;
    data.penType = element.penType;
    data.geoType = element.geoType; // e.g., 'GEO_polygon'
  } else if ([ELEMENT_TYPES.TEXT, ELEMENT_TYPES.TEXT_DIGEST_QUOTE, ELEMENT_TYPES.TEXT_DIGEST_CREATE].includes(element.type)) {
    data.text = element.text;
    data.rect = element.rect;
    data.fontSize = element.fontSize;
    // other text properties...
  } else if (element.type === ELEMENT_TYPES.LINK) {
    data.linkData = element.linkData;
    data.rect = element.rect;
  } else {
    return null; // Unsupported or Excluded (PICTURE, TITLE)
  }

  return {
    uuid: element.uuid,
    type: element.type,
    numInPage: element.numInPage,
    serializedData: JSON.stringify(data),
  };
}

export async function restoreElement(ce: CollapsedElement, dx: number, dy: number): Promise<boolean> {
  const data = JSON.parse(ce.serializedData);

  if (ce.type === ELEMENT_TYPES.STROKE) {
    const points = decodePoints(data.points).map(p => ({ x: p.x + dx, y: p.y + dy }));
    const res = await PluginNoteAPI.insertStroke({
      points,
      penWidth: data.penWidth,
      penColor: data.penColor,
      penType: data.penType,
    });
    return res.success;
  } else if (ce.type === ELEMENT_TYPES.GEO) {
    const points = decodePoints(data.points).map(p => ({ x: p.x + dx, y: p.y + dy }));
    const res = await PluginNoteAPI.insertGeometry({
      type: data.geoType,
      points,
      penWidth: data.penWidth,
      penColor: data.penColor,
      penType: data.penType,
    });
    return res.success;
  } else if ([ELEMENT_TYPES.TEXT, ELEMENT_TYPES.TEXT_DIGEST_QUOTE, ELEMENT_TYPES.TEXT_DIGEST_CREATE].includes(ce.type)) {
    const rect = {
      left: data.rect.left + dx,
      top: data.rect.top + dy,
      right: data.rect.right + dx,
      bottom: data.rect.bottom + dy,
    };
    const res = await PluginNoteAPI.insertText({
      text: data.text,
      rect,
      fontSize: data.fontSize,
      type: ce.type,
    });
    return res.success;
  } else if (ce.type === ELEMENT_TYPES.LINK) {
    const rect = {
      left: data.rect.left + dx,
      top: data.rect.top + dy,
      right: data.rect.right + dx,
      bottom: data.rect.bottom + dy,
    };
    // Assuming insertLink exists or similar
    const res = await PluginNoteAPI.insertLink({
      linkData: data.linkData,
      rect,
    });
    return res.success;
  }

  return false;
}
