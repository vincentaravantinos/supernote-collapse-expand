import { PluginCommAPI, PluginFileAPI, PluginNoteAPI } from 'sn-plugin-lib';
import { ELEMENT_TYPES, LOG } from '../constants';

// Minimal, self-contained reproduction of the insertElements/getElements
// cache-vs-file mismatch raised in
// https://www.reddit.com/r/Supernote_dev/comments/1tdw909/comment/omngte2/
//
// The dev (Dunn-sn) replied that insertElements is supposed to internally
// sync the backup file and actual note file, so a subsequent getElements
// should already see the inserted element. We're still observing the
// opposite. This function isolates the question with a single insert and
// no other plugin state in the way, so the trace is easy to triage.

function getCount(res: any): number {
  if (!res?.success || !Array.isArray(res.result)) return -1;
  return res.result.length;
}

function recycleAll(res: any): void {
  if (!res?.success || !Array.isArray(res.result)) return;
  for (const e of res.result) {
    try { e.recycle?.(); } catch { /* ignore */ }
  }
}

export async function runInsertGetRepro(filePath: string, page: number): Promise<void> {
  console.log(`${LOG} REPRO START filePath=${filePath} page=${page}`);

  // 1. Flush any pending cache writes so the baseline matches the file.
  await PluginNoteAPI.saveCurrentNote();

  // 2. Baseline: how many elements does the file have right now?
  const r1: any = await PluginFileAPI.getElements(page, filePath);
  const baseline = getCount(r1);
  recycleAll(r1);
  console.log(`${LOG} REPRO baseline getElements count=${baseline}`);

  // 3. Build the simplest GEO polygon we know works (mirrors maskHelpers).
  const createRes: any = await PluginCommAPI.createElement(ELEMENT_TYPES.GEO);
  if (!createRes?.success || !createRes.result) {
    console.error(`${LOG} REPRO createElement(GEO) failed res=${JSON.stringify(createRes)}`);
    return;
  }
  const el: any = createRes.result;
  el.geometry = {
    type: 'GEO_polygon',
    points: [
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 20, y: 20 },
      { x: 10, y: 20 },
      { x: 10, y: 10 },
    ],
    penColor: 0xC9,
    penType: 10,
    penWidth: 18000,
  };
  el.pageNum = page;

  // 4. Insert the single element. No save afterwards.
  const ins: any = await PluginFileAPI.insertElements(filePath, page, [el]);
  if (!ins?.success) {
    console.error(`${LOG} REPRO insertElements failed res=${JSON.stringify(ins)}`);
    try { el.recycle?.(); } catch { /* ignore */ }
    return;
  }
  const insertedNum = el?.numInPage;
  console.log(`${LOG} REPRO insertElements OK numInPage=${insertedNum}`);

  // 5. getElements WITHOUT a save in between. Per dev's claim this should
  //    already include the new element (baseline + 1).
  const r2: any = await PluginFileAPI.getElements(page, filePath);
  const afterInsert = getCount(r2);
  recycleAll(r2);
  console.log(`${LOG} REPRO after insert (NO save) getElements count=${afterInsert}`);

  // 6. Force a save and re-read so we can compare.
  await PluginNoteAPI.saveCurrentNote();
  const r3: any = await PluginFileAPI.getElements(page, filePath);
  const afterSave = getCount(r3);
  recycleAll(r3);
  console.log(`${LOG} REPRO after save getElements count=${afterSave}`);

  const expectedAfterInsert = baseline + 1;
  const bugReproduced =
    baseline >= 0 &&
    afterInsert === baseline &&
    afterSave === expectedAfterInsert;

  console.log(
    `${LOG} REPRO SUMMARY baseline=${baseline} afterInsert=${afterInsert}` +
    ` afterSave=${afterSave} expectedAfterInsert=${expectedAfterInsert}` +
    ` bugReproduced=${bugReproduced}`,
  );

  // 7. Clean up: delete the polygon we just inserted so we don't pollute
  //    the page across runs.
  if (typeof insertedNum === 'number') {
    const del: any = await PluginFileAPI.deleteElements(filePath, page, [insertedNum]);
    if (!del?.success) {
      console.error(`${LOG} REPRO cleanup deleteElements failed res=${JSON.stringify(del)}`);
    } else {
      console.log(`${LOG} REPRO cleanup deleteElements OK`);
    }
    await PluginNoteAPI.saveCurrentNote();
  }

  try { el?.recycle?.(); } catch { /* ignore */ }

  console.log(`${LOG} REPRO END`);
}
