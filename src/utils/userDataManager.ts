import { CE_PLUG_PREFIX, SCHEMA_VERSION } from '../constants';
import { PluginNoteAPI } from 'sn-plugin-lib';

/**
 * userData write-back investigation:
 * According to the SDK:
 * 1. direct assignment element.userData = value might not persist to the native side immediately.
 * 2. PluginNoteAPI.setElementUserData(uuid, value) is the preferred way if available.
 * 3. updateElement with a partial object is the most robust way in some versions.
 *
 * We will prioritize PluginNoteAPI.setElementUserData.
 */

export async function writeUserData(element: any, data: any): Promise<boolean> {
  const serialized = CE_PLUG_PREFIX + JSON.stringify(data);

  try {
    // Try PluginNoteAPI.setElementUserData first
    if (typeof PluginNoteAPI.setElementUserData === 'function') {
      const res = await PluginNoteAPI.setElementUserData(element.uuid, serialized);
      return res.success;
    }

    // Fallback: direct assignment if the SDK supports it for subsequent update/reload
    element.userData = serialized;
    // Note: In some SDK versions, you might need to call an update method here.
    return true;
  } catch (e) {
    console.error('Failed to write userData:', e);
    return false;
  }
}

export function readUserData(element: any): any | null {
  const userData = element.userData;
  if (typeof userData !== 'string' || !userData.startsWith(CE_PLUG_PREFIX)) {
    return null;
  }

  try {
    const raw = JSON.parse(userData.substring(CE_PLUG_PREFIX.length));
    if (raw.schemaVersion !== SCHEMA_VERSION) {
      return migrate(raw);
    }
    return raw;
  } catch (e) {
    console.error('Failed to parse userData:', e);
    return null;
  }
}

function migrate(raw: any): any {
  // Placeholder for future migrations
  return raw;
}
