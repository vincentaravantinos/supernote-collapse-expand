import { PluginCommAPI, PluginFileAPI, Point, Rect } from 'sn-plugin-lib';
import { CE_PART_PREFIX, ELEMENT_TYPES, LOG } from '../constants';
import { buildElement, buildStrokeLink } from '../utils/elementSerializer';
import { CollapsedElement, SerializedLink } from '../model/types';

export interface StrokeLinkExpandCtx {
  filePath: string;
  page: number;
  collapsedElements: CollapsedElement[];
  sectionId: string;
  emrDelta: Point;
  pageMaxX: number;
  pageMaxY: number;
  dx: number;
  dy: number;
  // Pre-built elements the caller would otherwise insert itself. In the
  // stroke-link path this function owns the whole insert sequence so it can
  // recover the members' new page nums with one reload PER LINK and no extra
  // baseline reload (see header comment on rebuildStrokeLinks).
  maskElements: any[];
  otherElements: any[];
}

function isStrokeLink(ce: CollapsedElement): boolean {
  const d = ce.data;
  return d.kind === 'link' && d.category === 1 && !!d.memberIndices;
}

// Indexes into `collapsed` of the strokes that belong to a stroke link
// (category 1). These members are re-inserted in their own batch by
// `rebuildStrokeLinks`, so the main expand batch must EXCLUDE them.
export function strokeLinkMemberIndices(collapsed: CollapsedElement[]): Set<number> {
  const set = new Set<number>();
  for (const ce of collapsed) {
    if (isStrokeLink(ce)) {
      for (const idx of (ce.data as SerializedLink).memberIndices!) set.add(idx);
    }
  }
  return set;
}

async function insertBatch(filePath: string, page: number, batch: any[]): Promise<boolean> {
  if (batch.length === 0) return true;
  const ins: any = await PluginFileAPI.insertElements(filePath, page, batch);
  if (!ins?.success) console.error(`${LOG} insertElements failed res=${JSON.stringify(ins)}`);
  for (const el of batch) { try { el.recycle?.(); } catch { /* ignore */ } }
  return !!ins?.success;
}

// Rebuild stroke links (category 1) and insert the whole expand payload.
//
// A stroke link references its member strokes by page num, and re-inserting
// those strokes gives them NEW nums — so we must learn the new nums after
// re-insert. getElementNumList/getElements read the CACHED copy, which lags
// insertElements until a reloadFile (SDK_DOC: real↔cached split). The trick:
// insert a link's members (no other strokes) then reloadFile + getElements; the
// new stroke elements tagged for this section are exactly that link's members,
// and their nums are the link's controlTrailNums (order doesn't matter — it's a
// set). The link's own rect is just a non-empty placeholder; the device
// recomputes a stroke link's area from controlTrailNums (see SDK_DOC).
//
// To keep the screen refreshes minimal we (a) take the baseline WITHOUT a reload
// (the cached copy still shows the pre-expand page — the caller hasn't inserted
// anything yet in this path), (b) bundle the masks with the FIRST link's members
// (masks first, so they stay underneath), and (c) defer all other content + the
// link elements to one final batch that the caller's end-of-expand reload
// surfaces. Net cost: one reload per stroke link (vs. the old baseline + per-link
// + content reloads). Returns true iff every insert succeeded.
export async function rebuildStrokeLinks(ctx: StrokeLinkExpandCtx): Promise<boolean> {
  const { filePath, page, collapsedElements, sectionId, emrDelta, pageMaxX, pageMaxY, dx, dy, maskElements, otherElements } = ctx;
  const tag = CE_PART_PREFIX + sectionId;
  const links = collapsedElements.filter(isStrokeLink);

  // Degenerate guard: no resolvable stroke links — just insert mask + content.
  if (links.length === 0) {
    return insertBatch(filePath, page, [...maskElements, ...otherElements]);
  }

  let ok = true;

  const numListNow = async (): Promise<number[]> => {
    const r: any = await PluginFileAPI.getElementNumList(filePath, page);
    return r?.success && Array.isArray(r.result) ? r.result : [];
  };

  // Baseline: the page BEFORE we insert anything, read without a reload (cached
  // copy == pre-expand page, since the caller deferred its inserts to us).
  let knownNums = new Set<number>(await numListNow());

  const pending: { data: SerializedLink; memberNums: number[]; rect: Rect }[] = [];

  for (let i = 0; i < links.length; i++) {
    const d = links[i].data as SerializedLink;

    const memberEls: any[] = [];
    for (const idx of d.memberIndices!) {
      const member = collapsedElements[idx];
      if (!member) { console.error(`${LOG} stroke-link member index ${idx} out of range`); continue; }
      const el = await buildElement(member.data, page, tag, emrDelta, pageMaxX, pageMaxY, dx, dy);
      if (el) memberEls.push(el);
      else console.error(`${LOG} buildElement returned null for stroke-link member kind=${member.data.kind}`);
    }

    // Bundle the masks with the first link's members (masks first → underneath).
    const batch = i === 0 ? [...maskElements, ...memberEls] : memberEls;
    ok = (await insertBatch(filePath, page, batch)) && ok;

    // Reload (cached:=real) then read back; the section's NEW stroke elements
    // are this link's members (masks are geometry; other content/strokes aren't
    // inserted until the final batch; previous links' members are in knownNums).
    await PluginCommAPI.reloadFile();
    const chk: any = await PluginFileAPI.getElements(page, filePath);
    const els: any[] = chk?.success && Array.isArray(chk.result) ? chk.result : [];
    const memberNums = els
      .filter((e) => e?.type === ELEMENT_TYPES.STROKE && typeof e?.userData === 'string' && e.userData.startsWith(tag) && !knownNums.has(e.numInPage))
      .map((e) => e.numInPage);

    const rect: Rect = { left: d.rect.left + dx, top: d.rect.top + dy, right: d.rect.right + dx, bottom: d.rect.bottom + dy };
    pending.push({ data: d, memberNums, rect });
    knownNums = new Set(els.map((e) => e?.numInPage));
  }

  // Build the links (now that we know their members' nums) and insert them with
  // all the remaining content in one final batch. No reload here — the caller's
  // end-of-expand reloadFile surfaces it.
  const linkEls: any[] = [];
  for (const p of pending) {
    const el = await buildStrokeLink(p.data, page, tag, p.memberNums, p.rect);
    if (el) linkEls.push(el);
    else console.error(`${LOG} buildStrokeLink returned null`);
  }
  ok = (await insertBatch(filePath, page, [...otherElements, ...linkEls])) && ok;

  return ok;
}
