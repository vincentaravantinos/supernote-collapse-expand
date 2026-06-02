import { PluginCommAPI } from 'sn-plugin-lib';
import { LOG } from './constants';
import { readUserData } from './utils/userDataManager';
import { summarizeElements, summarizeSection } from './utils/diagnostics';
import { collapseAction } from './logic/collapseAction';
import { expandAction } from './logic/expandAction';
import { recollapseAction } from './logic/recollapseAction';
import { runInsertGetRepro } from './diagnostics/insertGetRepro';

// TEMPORARY diagnostic flag: when true, every button press runs the
// isolated insertElements/getElements repro and skips the normal
// collapse/expand flow. Flip back to false (or just delete the flag
// and this branch) once we have the trace we need.
const DIAGNOSTIC_REPRO_MODE = false;

export async function handleMainAction() {
  try {
    const filePathRes: any = await PluginCommAPI.getCurrentFilePath();
    const pageRes: any = await PluginCommAPI.getCurrentPageNum();
    if (!filePathRes?.success || typeof filePathRes.result !== 'string') {
      alert('Unable to determine current file path.');
      return;
    }
    if (!pageRes?.success || typeof pageRes.result !== 'number') {
      alert('Unable to determine current page.');
      return;
    }
    const filePath = filePathRes.result as string;
    const page = pageRes.result as number;

    if (DIAGNOSTIC_REPRO_MODE) {
      await runInsertGetRepro(filePath, page);
      return;
    }

    const elementsRes: any = await PluginCommAPI.getLassoElements();
    const elements: any[] = elementsRes?.success ? (elementsRes.result ?? []) : [];
    if (elements.length === 0) {
      alert('Please make a selection first.');
      return;
    }

    let iconElement: any = null;
    let section = null;
    for (const el of elements) {
      const ud = readUserData(el);
      if (ud?.kind === 'section') {
        iconElement = el;
        section = ud.section;
        break;
      }
    }

    try {
      if (iconElement && section) {
        if (section.isExpanded) {
          console.info(`${LOG} RECOLLAPSE - section: ${summarizeSection(section)}`);
          await recollapseAction(section, iconElement, filePath, page);
        } else {
          console.info(`${LOG} EXPAND - section: ${summarizeSection(section)}`);
          await expandAction(section, iconElement, filePath, page);
        }
      } else {
        console.info(`${LOG} COLLAPSE - elements: ${summarizeElements(elements)}`);
        await collapseAction(filePath, page, elements);
      }
    } finally {
      for (const el of elements) {
        try { el.recycle?.(); } catch { /* ignore */ }
      }
    }
  } catch (error) {
    console.error(`${LOG} Plugin action failed:`, error);
    alert('An error occurred during processing.');
  }
}
