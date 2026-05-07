import { PluginFileAPI } from 'sn-plugin-lib';
import { LOG } from '../constants';

export async function dumpElements(label: string, filePath: string, page: number): Promise<void> {
  const allRes: any = await PluginFileAPI.getElements(page, filePath);
  const all: any[] = allRes?.success && Array.isArray(allRes.result) ? allRes.result : [];
  console.log(`${LOG} ${label} count=${all.length} ${all.map(f => `(num=${f?.numInPage} type=${f?.type} udLen=${typeof f?.userData === 'string' ? f.userData.length : 'n/a'} maxX=${f?.maxX} maxY=${f?.maxY})`).join(', ')}`);
}
