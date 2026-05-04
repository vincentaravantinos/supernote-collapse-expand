import { PluginCommAPI, Point, Rect } from 'sn-plugin-lib';
import { ELEMENT_TYPES } from '../constants';
import {
  SerializedElement,
  SerializedGeometry,
  SerializedLink,
  SerializedStroke,
  SerializedText,
} from '../model/types';

function translatePoints(points: Point[], dx: number, dy: number): Point[] {
  return points.map(p => ({ x: p.x + dx, y: p.y + dy }));
}

function translateRect(rect: Rect, dx: number, dy: number): Rect {
  return {
    left: rect.left + dx,
    top: rect.top + dy,
    right: rect.right + dx,
    bottom: rect.bottom + dy,
  };
}

function roundRect(rect: Rect): Rect {
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    right: Math.round(rect.right),
    bottom: Math.round(rect.bottom),
  };
}

async function drainAccessor<T>(accessor: any): Promise<T[]> {
  if (!accessor || typeof accessor.size !== 'function') return [];
  const size = await accessor.size();
  if (!size || size <= 0) return [];
  return await accessor.getRange(0, size);
}

export async function serializeElement(el: any): Promise<SerializedElement | null> {
  const type = el?.type;

  if (type === ELEMENT_TYPES.STROKE) {
    if (!el.stroke) return null;
    const rawPoints = await drainAccessor<Point>(el.stroke.points);
    const rawPressures = await drainAccessor<number>(el.stroke.pressures);
    const data: SerializedStroke = {
      kind: 'stroke',
      thickness: el.thickness ?? 0,
      penColor: el.stroke.penColor ?? 0,
      penType: el.stroke.penType ?? 0,
      points: rawPoints.map(p => ({ x: p.x, y: p.y })),
      pressures: rawPressures.slice(),
    };
    if (typeof el.layerNum === 'number') data.layerNum = el.layerNum;
    if (typeof el.maxX === 'number' && el.maxX > 0) data.maxX = el.maxX;
    if (typeof el.maxY === 'number' && el.maxY > 0) data.maxY = el.maxY;
    return data;
  }

  if (
    type === ELEMENT_TYPES.TEXT ||
    type === ELEMENT_TYPES.TEXT_DIGEST_QUOTE ||
    type === ELEMENT_TYPES.TEXT_DIGEST_CREATE
  ) {
    const tb = el.textBox;
    if (!tb) return null;
    const data: SerializedText = {
      kind: 'text',
      type,
      textContentFull: tb.textContentFull ?? '',
      textRect: {
        left: tb.textRect?.left ?? 0,
        top: tb.textRect?.top ?? 0,
        right: tb.textRect?.right ?? 0,
        bottom: tb.textRect?.bottom ?? 0,
      },
      fontSize: tb.fontSize ?? 0,
      textAlign: tb.textAlign ?? 0,
      textBold: tb.textBold ?? 0,
      textItalics: tb.textItalics ?? 0,
      textFrameWidthType: tb.textFrameWidthType ?? 0,
      textFrameStyle: tb.textFrameStyle ?? 0,
      textEditable: tb.textEditable ?? 0,
    };
    return data;
  }

  if (type === ELEMENT_TYPES.LINK) {
    const lk = el.link;
    if (!lk) return null;
    const data: SerializedLink = {
      kind: 'link',
      category: lk.category ?? 0,
      rect: {
        left: lk.X ?? 0,
        top: lk.Y ?? 0,
        right: (lk.X ?? 0) + (lk.width ?? 0),
        bottom: (lk.Y ?? 0) + (lk.height ?? 0),
      },
      style: lk.style ?? 0,
      linkType: lk.linkType ?? 0,
      destPath: lk.destPath ?? '',
      destPage: lk.destPage ?? 0,
      fontSize: lk.fontSize ?? 0,
      fullText: lk.fullText ?? '',
      showText: lk.showText ?? '',
      italic: lk.italic ?? 0,
    };
    return data;
  }

  if (type === ELEMENT_TYPES.GEO) {
    const g = el.geometry;
    if (!g) return null;
    const data: SerializedGeometry = {
      kind: 'geometry',
      geoType: g.type ?? 'GEO_polygon',
      points: (g.points ?? []).map((p: Point) => ({ x: p.x, y: p.y })),
      penColor: g.penColor ?? 0,
      penType: g.penType ?? 0,
      penWidth: g.penWidth ?? 100,
    };
    return data;
  }

  return null;
}

export async function buildElement(
  data: SerializedElement,
  page: number,
  userData: string | null,
  emrDelta: Point,
  pageMaxX: number,
  pageMaxY: number,
  dxPx: number,
  dyPx: number,
): Promise<any | null> {
  if (data.kind === 'stroke') return buildStroke(data, page, userData, emrDelta, pageMaxX, pageMaxY);
  if (data.kind === 'text') return buildText(data, page, userData, dxPx, dyPx);
  if (data.kind === 'link') return buildLink(data, page, userData, dxPx, dyPx);
  if (data.kind === 'geometry') return buildGeometry(data, page, userData, dxPx, dyPx);
  return null;
}

async function buildStroke(
  data: SerializedStroke,
  page: number,
  userData: string | null,
  emrDelta: Point,
  pageMaxX: number,
  pageMaxY: number,
): Promise<any | null> {
  const res: any = await PluginCommAPI.createElement(ELEMENT_TYPES.STROKE);
  if (!res?.success || !res.result) return null;
  const element: any = res.result;

  element.thickness = data.thickness;
  element.pageNum = page;
  element.layerNum = data.layerNum ?? 0;
  if (userData !== null) element.userData = userData;
  if (!element.stroke) element.stroke = {};
  element.stroke.penColor = data.penColor;
  element.stroke.penType = data.penType;

  // Native side forces new strokes into the page's (maxX, maxY) space, so
  // rescale captured points if they were drawn in a different space.
  const sx = data.maxX && data.maxX > 0 ? pageMaxX / data.maxX : 1;
  const sy = data.maxY && data.maxY > 0 ? pageMaxY / data.maxY : 1;
  const points = data.points.map(p => ({
    x: Math.round(p.x * sx + emrDelta.x),
    y: Math.round(p.y * sy + emrDelta.y),
  }));
  if (points.length > 0) {
    await element.stroke.points.setRange(0, points.length, points);
  }
  if (data.pressures && data.pressures.length > 0) {
    await element.stroke.pressures.setRange(0, data.pressures.length, data.pressures);
  }

  return element;
}

async function buildText(
  data: SerializedText,
  page: number,
  userData: string | null,
  dx: number,
  dy: number,
): Promise<any | null> {
  const res: any = await PluginCommAPI.createElement(data.type);
  if (!res?.success || !res.result) return null;
  const element: any = res.result;

  element.textBox = {
    fontSize: data.fontSize,
    textContentFull: data.textContentFull,
    textRect: roundRect(translateRect(data.textRect, dx, dy)),
    textAlign: data.textAlign,
    textBold: data.textBold,
    textItalics: data.textItalics,
    textFrameWidthType: data.textFrameWidthType,
    textFrameStyle: data.textFrameStyle,
    textEditable: data.textEditable,
  };
  element.pageNum = page;
  if (userData !== null) element.userData = userData;
  return element;
}

async function buildLink(
  data: SerializedLink,
  page: number,
  userData: string | null,
  dx: number,
  dy: number,
): Promise<any | null> {
  const res: any = await PluginCommAPI.createElement(ELEMENT_TYPES.LINK);
  if (!res?.success || !res.result) return null;
  const element: any = res.result;

  const rect = roundRect(translateRect(data.rect, dx, dy));
  element.link = {
    category: data.category,
    X: rect.left,
    Y: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    style: data.style,
    linkType: data.linkType,
    destPath: data.destPath,
    destPage: data.destPage,
    fontSize: data.fontSize,
    fullText: data.fullText,
    showText: data.showText,
    italic: data.italic,
  };
  element.pageNum = page;
  if (userData !== null) element.userData = userData;
  return element;
}

async function buildGeometry(
  data: SerializedGeometry,
  page: number,
  userData: string | null,
  dx: number,
  dy: number,
): Promise<any | null> {
  const res: any = await PluginCommAPI.createElement(ELEMENT_TYPES.GEO);
  if (!res?.success || !res.result) return null;
  const element: any = res.result;

  element.geometry = {
    type: data.geoType,
    points: translatePoints(data.points, dx, dy),
    penColor: data.penColor,
    penType: data.penType,
    penWidth: data.penWidth,
  };
  element.pageNum = page;
  if (userData !== null) element.userData = userData;
  return element;
}
