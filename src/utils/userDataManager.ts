import { PluginFileAPI, PluginManager } from 'sn-plugin-lib';
import {
  CE_MASK_PREFIX,
  CE_PART_PREFIX,
  CE_PLUG_PREFIX,
  DEFAULT_ICON_FILENAME,
  LOG,
} from '../constants';
import { CollapseSection } from '../model/types';

export type UserDataKind =
  | { kind: 'section'; section: CollapseSection }
  | { kind: 'part'; id: string }
  | { kind: 'mask'; id: string }
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

  if (udata.startsWith(CE_PART_PREFIX)) {
    return { kind: 'part', id: udata.substring(CE_PART_PREFIX.length) };
  }

  if (udata.startsWith(CE_MASK_PREFIX)) {
    return { kind: 'mask', id: udata.substring(CE_MASK_PREFIX.length) };
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
    // The picturePath returned by getElements points at an SDK-internal
    // cache (/storage/emulated/0/.data/plugin/<millis>.png) that doesn't
    // actually exist on disk, so modifyElements fails with code 1211
    // ("PNG file does not exist"). Re-anchor to the bundled icon before
    // calling the SDK.
    if (iconElement.picture) {
      const dirRes: any = await PluginManager.getPluginDirPath();
      const pluginDir: string | null =
        typeof dirRes === 'string' ? dirRes : (dirRes?.result ?? null);
      if (typeof pluginDir === 'string' && pluginDir.length > 0) {
        iconElement.picture = {
          ...iconElement.picture,
          picturePath: `${pluginDir.replace(/\/+$/, '')}/${DEFAULT_ICON_FILENAME}`,
        };
      }
    }
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
