import { PluginCommAPI, PluginNoteAPI, Point, Rect } from 'sn-plugin-lib';
import { ELEMENT_TYPES, LOG } from '../constants';
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

function transformStrokePoints(
  points: Point[],
  kx: number,
  ky: number,
  dEmrX: number,
  dEmrY: number,
): Point[] {
  return points.map(p => ({
    x: Math.round(p.x * kx + dEmrX),
    y: Math.round(p.y * ky + dEmrY),
  }));
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
    if (typeof el.emrPointAxis === 'number') data.emrPointAxis = el.emrPointAxis;
    if (typeof el.factorResize === 'number') data.factorResize = el.factorResize;
    if (typeof el.layerNum === 'number') data.layerNum = el.layerNum;
    if (typeof el.maxX === 'number') data.maxX = el.maxX;
    if (typeof el.maxY === 'number') data.maxY = el.maxY;
    console.log(`${LOG} serialize stroke emrPointAxis=${el.emrPointAxis} factorResize=${el.factorResize} layerNum=${el.layerNum} maxX=${el.maxX} maxY=${el.maxY} firstPt=${JSON.stringify(rawPoints[0])} nPts=${rawPoints.length}`);
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

export async function restoreNonStrokeElement(
  data: SerializedElement,
  dx: number,
  dy: number,
): Promise<boolean> {
  try {
    if (data.kind === 'text') return await restoreText(data, dx, dy);
    if (data.kind === 'link') return await restoreLink(data, dx, dy);
    if (data.kind === 'geometry') return await restoreGeometry(data, dx, dy);
  } catch (e) {
    console.error(`${LOG} restoreNonStrokeElement failed:`, e);
  }
  return false;
}

export interface StrokeBuildContext {
  targetMaxX: number;
  targetMaxY: number;
  dEmrX: number;
  dEmrY: number;
}

export async function buildStrokeElement(
  data: SerializedStroke,
  page: number,
  ctx: StrokeBuildContext,
): Promise<any | null> {
  const res: any = await PluginCommAPI.createElement(ELEMENT_TYPES.STROKE);
  if (!res?.success || !res.result) return null;
  const element: any = res.result;

  element.thickness = data.thickness;
  element.pageNum = page;
  element.layerNum = data.layerNum ?? 0;
  if (!element.stroke) element.stroke = {};
  element.stroke.penColor = data.penColor;
  element.stroke.penType = data.penType;

  const origMaxX = data.maxX && data.maxX > 0 ? data.maxX : ctx.targetMaxX;
  const origMaxY = data.maxY && data.maxY > 0 ? data.maxY : ctx.targetMaxY;
  const kx = ctx.targetMaxX / origMaxX;
  const ky = ctx.targetMaxY / origMaxY;

  const points = transformStrokePoints(data.points, kx, ky, ctx.dEmrX, ctx.dEmrY);
  if (points.length > 0) {
    await element.stroke.points.setRange(0, points.length, points);
  }
  if (data.pressures && data.pressures.length > 0) {
    await element.stroke.pressures.setRange(0, data.pressures.length, data.pressures);
  }

  console.log(`${LOG} build stroke origMax=(${origMaxX},${origMaxY}) target=(${ctx.targetMaxX},${ctx.targetMaxY}) k=(${kx.toFixed(3)},${ky.toFixed(3)}) dEmr=(${ctx.dEmrX.toFixed(1)},${ctx.dEmrY.toFixed(1)}) firstPt=${JSON.stringify(points[0])} nPts=${points.length}`);

  return element;
}

async function restoreText(data: SerializedText, dx: number, dy: number): Promise<boolean> {
  const rect = roundRect(translateRect(data.textRect, dx, dy));
  const res: any = await PluginNoteAPI.insertText({
    fontSize: data.fontSize,
    textContentFull: data.textContentFull,
    textRect: rect,
    textAlign: data.textAlign,
    textBold: data.textBold,
    textItalics: data.textItalics,
    textFrameWidthType: data.textFrameWidthType,
    textFrameStyle: data.textFrameStyle,
    textEditable: data.textEditable,
  });
  return !!res?.success;
}

async function restoreLink(data: SerializedLink, dx: number, dy: number): Promise<boolean> {
  const rect = roundRect(translateRect(data.rect, dx, dy));
  const res: any = await PluginNoteAPI.insertTextLink({
    destPath: data.destPath,
    destPage: data.destPage,
    style: data.style,
    linkType: data.linkType,
    rect,
    fontSize: data.fontSize,
    fullText: data.fullText,
    showText: data.showText,
    isItalic: data.italic,
  });
  return !!res?.success;
}

async function restoreGeometry(data: SerializedGeometry, dx: number, dy: number): Promise<boolean> {
  const points = translatePoints(data.points, dx, dy);
  const res: any = await PluginCommAPI.insertGeometry({
    type: data.geoType,
    points,
    penColor: data.penColor,
    penType: data.penType,
    penWidth: data.penWidth,
  });
  return !!res?.success;
}
