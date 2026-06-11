import { PluginCommAPI, Point, PointUtils, Rect } from 'sn-plugin-lib';
import { ELEMENT_TYPES, LOG } from '../constants';
import {
  CollapsedElement,
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

// Bounding box (android page coords) of serialized elements. Strokes are stored
// in EMR space, so convert to android the same way buildStroke positions them;
// text/link/geometry are already android. Used to define a section's zone from
// its content. Returns null if empty.
export function contentBoundingBox(
  collapsed: CollapsedElement[],
  pageSize: { width: number; height: number },
): Rect | null {
  const pageMaxX = PointUtils.getRealMaxX(pageSize);
  const pageMaxY = PointUtils.getRealMaxY(pageSize);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const ext = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const ce of collapsed) {
    const d = ce.data;
    if (d.kind === 'stroke') {
      if (d.points.length === 0) continue;
      // EMR→android is affine, so take the EMR bbox and convert only its 4
      // corners instead of every point (avoids a per-point conversion call).
      const sx = d.maxX && d.maxX > 0 ? pageMaxX / d.maxX : 1;
      const sy = d.maxY && d.maxY > 0 ? pageMaxY / d.maxY : 1;
      let exMin = Infinity, eyMin = Infinity, exMax = -Infinity, eyMax = -Infinity;
      for (const p of d.points) {
        const ex = p.x * sx, ey = p.y * sy;
        if (ex < exMin) exMin = ex;
        if (ex > exMax) exMax = ex;
        if (ey < eyMin) eyMin = ey;
        if (ey > eyMax) eyMax = ey;
      }
      for (const c of [[exMin, eyMin], [exMin, eyMax], [exMax, eyMin], [exMax, eyMax]]) {
        const a = PointUtils.emrPoint2Android({ x: c[0], y: c[1] }, pageSize);
        ext(a.x, a.y);
      }
    } else if (d.kind === 'text') {
      ext(d.textRect.left, d.textRect.top);
      ext(d.textRect.right, d.textRect.bottom);
    } else if (d.kind === 'link') {
      ext(d.rect.left, d.rect.top);
      ext(d.rect.right, d.rect.bottom);
    } else if (d.kind === 'geometry') {
      for (const p of d.points) ext(p.x, p.y);
    }
  }
  if (minX === Infinity) return null;
  return roundRect({ left: minX, top: minY, right: maxX, bottom: maxY });
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
    // Stroke links reference their strokes by controlTrailNums (page nums).
    // Capture raw; resolveLinkMemberIndices converts them to stable indexes
    // (page nums don't survive the round-trip).
    if ((lk.category ?? 0) === 1) {
      const ctn = (lk as any).controlTrailNums;
      data.srcControlNums = Array.isArray(ctn) ? [...ctn] : [];
    }
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
  // rescale points captured in a different space.
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
  // Stroke links are built later by buildStrokeLink, once their member strokes
  // are re-inserted and their new page nums are known (building one with
  // empty/invalid controlTrailNums throws error 510). Skip them here.
  if (data.category === 1) return null;
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
    // `page` = the page the link lives on (not the jump target, `destPage`);
    // omitting it on a rebuilt link risks error 502.
    page,
    style: data.style,
    linkType: data.linkType,
    destPath: data.destPath,
    destPage: data.destPage,
    fontSize: data.fontSize,
    fullText: data.fullText,
    showText: data.showText,
    italic: data.italic,
    controlTrailNums: [], // text links have none; stale refs throw 502
  };
  element.pageNum = page;
  if (userData !== null) element.userData = userData;
  return element;
}

// Build a stroke link (category 1), called after its member strokes are
// re-inserted with `controlNums` set to their new page nums. `rect` only has to
// be a valid non-empty placeholder: the device rejects a zero rect (error 509)
// but otherwise ignores the size we pass and recomputes the area from
// controlTrailNums. (Text links DO honor their rect — that's buildLink.)
export async function buildStrokeLink(
  data: SerializedLink,
  page: number,
  userData: string | null,
  controlNums: number[],
  rect: Rect,
): Promise<any | null> {
  const res: any = await PluginCommAPI.createElement(ELEMENT_TYPES.LINK);
  if (!res?.success || !res.result) return null;
  const element: any = res.result;

  const r = roundRect(rect);
  element.link = {
    category: 1,
    X: r.left,
    Y: r.top,
    width: r.right - r.left,
    height: r.bottom - r.top,
    page,
    style: data.style,
    linkType: data.linkType,
    destPath: data.destPath,
    destPage: data.destPage,
    fontSize: data.fontSize,
    fullText: data.fullText,
    showText: data.showText,
    italic: data.italic,
    controlTrailNums: controlNums,
  };
  element.pageNum = page;
  if (userData !== null) element.userData = userData;
  return element;
}

// Convert each stroke link's raw page-num srcControlNums into stable indexes
// into `collapsed` (memberIndices), so the reference survives the round-trip.
// A link whose members aren't all present is dropped (its strokes stay) + alert.
export function resolveLinkMemberIndices(collapsed: CollapsedElement[]): CollapsedElement[] {
  let dropped = false;
  const presentNums = new Set(collapsed.map((ce) => ce.numInPage));
  const kept = collapsed.filter((ce) => {
    const d = ce.data;
    if (d.kind === 'link' && d.category === 1 && d.srcControlNums) {
      if (!d.srcControlNums.every((n) => presentNums.has(n))) {
        console.error(`${LOG} stroke link dropped: member stroke(s) not in collapsed set (controlTrailNums=[${d.srcControlNums.join(',')}])`);
        dropped = true;
        return false;
      }
    }
    return true;
  });
  const numToIndex = new Map<number, number>();
  kept.forEach((ce, i) => numToIndex.set(ce.numInPage, i));
  for (const ce of kept) {
    const d = ce.data;
    if (d.kind === 'link' && d.category === 1 && d.srcControlNums) {
      d.memberIndices = d.srcControlNums.map((n) => numToIndex.get(n) as number);
      delete d.srcControlNums;
    }
  }
  if (dropped) {
    alert('A handwritten link could not be fully collapsed and was dropped (its strokes were kept).');
  }
  return kept;
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
