import { PluginCommAPI } from 'sn-plugin-lib';

export async function getCurrentFilePathOrNull(): Promise<string | null> {
  const res: any = await PluginCommAPI.getCurrentFilePath();
  return res?.success && typeof res.result === 'string' ? res.result : null;
}

export async function getCurrentPageNumOrNull(): Promise<number | null> {
  const res: any = await PluginCommAPI.getCurrentPageNum();
  return res?.success && typeof res.result === 'number' ? res.result : null;
}

// Both together, for the common case of needing filePath+page as a pair.
export async function getCurrentFileContext(): Promise<{ filePath: string; page: number } | null> {
  const filePath = await getCurrentFilePathOrNull();
  const page = await getCurrentPageNumOrNull();
  return filePath !== null && page !== null ? { filePath, page } : null;
}
