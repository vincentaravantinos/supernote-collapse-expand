import { PluginFileAPI } from 'sn-plugin-lib';
import {
  CE_BORDER_PREFIX,
  CE_PART_PREFIX,
  CE_PLUG_PREFIX,
  LOG,
} from '../constants';
import { CollapseSection } from '../model/types';

export type UserDataKind =
  | { kind: 'section'; section: CollapseSection }
  | { kind: 'border'; id: string }
  | { kind: 'part'; id: string }
  | null;

export function readUserData(element: any): UserDataKind {
  const udata = element?.userData;
  if (typeof udata !== 'string') return null;

  if (udata.startsWith(CE_PLUG_PREFIX)) {
    try {
      const section = JSON.parse(udata.substring(CE_PLUG_PREFIX.length));
      return { kind: 'section', section: section as CollapseSection };
    } catch (e) {
      console.error(`${LOG} Failed to parse CE_PLUG userData:`, e);
      return null;
    }
  }

  if (udata.startsWith(CE_BORDER_PREFIX)) {
    return { kind: 'border', id: udata.substring(CE_BORDER_PREFIX.length) };
  }

  if (udata.startsWith(CE_PART_PREFIX)) {
    return { kind: 'part', id: udata.substring(CE_PART_PREFIX.length) };
  }

  return null;
}

export async function writeSection(
  filePath: string,
  page: number,
  iconElement: any,
  section: CollapseSection,
): Promise<boolean> {
  try {
    iconElement.userData = CE_PLUG_PREFIX + JSON.stringify(section);
    iconElement.pageNum = page;
    const res: any = await PluginFileAPI.modifyElements(filePath, page, [iconElement]);
    if (!res?.success) {
      console.error(`${LOG} modifyElements res=${JSON.stringify(res)}`);
    }
    return !!res?.success;
  } catch (e) {
    console.error(`${LOG} Failed to write userData:`, e);
    return false;
  }
}
