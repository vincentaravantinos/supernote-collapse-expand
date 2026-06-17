import { NativePluginManager } from 'sn-plugin-lib';

// getOrientation() returns 0/2 for portrait, 1/3 for landscape.
// In landscape the Supernote renders a split half-page; the lasso pipeline
// can hang there, so callers should bail out rather than risk a freeze.
export async function isLandscape(): Promise<boolean> {
  try {
    const o = await (NativePluginManager as any).getOrientation();
    return o === 1 || o === 3;
  } catch {
    return false; // assume portrait if unavailable
  }
}
