import { PluginFileAPI } from 'sn-plugin-lib';
import {
  CE_BORDER_PREFIX,
  CE_PLUG_PREFIX,
  LOG,
  SCHEMA_VERSION,
} from '../constants';
import { CollapseSection } from '../model/types';

export type UserDataKind =
  | { kind: 'section'; section: CollapseSection }
  | { kind: 'border' }
  | null;

export function readUserData(element: any): UserDataKind {
  const udata = element?.userData;
  if (typeof udata !== 'string') return null;

  if (udata.startsWith(CE_PLUG_PREFIX)) {
    try {
      const parsed = JSON.parse(udata.substring(CE_PLUG_PREFIX.length));
      const section = parsed.schemaVersion === SCHEMA_VERSION ? parsed : migrate(parsed);
      return { kind: 'section', section: section as CollapseSection };
    } catch (e) {
      console.error(`${LOG} Failed to parse CE_PLUG userData:`, e);
      return null;
    }
  }

  if (udata.startsWith(CE_BORDER_PREFIX)) {
    return { kind: 'border' };
  }

  return null;
}

export async function writeSection(
  filePath: string,
  page: number,
  iconElement: any,
  section: CollapseSection,
): Promise<boolean> {
  return writeRaw(filePath, page, iconElement, CE_PLUG_PREFIX + JSON.stringify(section));
}

export async function writeBorderMarker(
  filePath: string,
  page: number,
  borderElement: any,
): Promise<boolean> {
  return writeRaw(filePath, page, borderElement, CE_BORDER_PREFIX);
}

async function writeRaw(
  filePath: string,
  page: number,
  element: any,
  value: string,
): Promise<boolean> {
  try {
    element.userData = value;
    element.pageNum = page;
    const res: any = await PluginFileAPI.modifyElements(filePath, page, [element]);
    if (!res?.success) {
      console.error(`${LOG} modifyElements res=${JSON.stringify(res)}`);
    } else {
      console.log(`${LOG} modifyElements ok result=${JSON.stringify(res.result)}`);
    }
    return !!res?.success;
  } catch (e) {
    console.error(`${LOG} Failed to write userData:`, e);
    return false;
  }
}

function migrate(raw: any): any {
  return raw;
}
