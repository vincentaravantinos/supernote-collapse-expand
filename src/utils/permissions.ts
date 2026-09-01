import { PluginManager } from 'sn-plugin-lib';
import { dlog, LOG, PERM_FILE_READ, PERM_FILE_WRITE } from '../constants';

// Grants only — never denials. This is what makes "ask again next time"
// (SPEC.md REQ-040) correct by construction: a decline just isn't cached,
// so the next call re-checks hasPermission / re-prompts.
const GRANTED = new Set<string>();

// Shown as the native dialog's own description (and on the Settings
// permissions page) for each permission — distinct from ensurePermissions'
// `message` param, which is this plugin's own denial alert.
//
// Only READ and WRITE — no FILE:DELETE. Per the official docs
// (docs.supernote.com/en/plugin-base/permission, Permission Dependencies):
// FILE:DELETE gates file-level deletion; deleteElements/deletePageElements
// ("remove note content, which is essentially a file modification") are
// validated against FILE:WRITE instead. This plugin never deletes a whole
// file/note, only elements within the open one — via insertElements,
// modifyElements, and deleteElements, all WRITE-gated — so it has no use
// for FILE:DELETE at all.
const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  [PERM_FILE_READ]: 'Collapse/Expand needs to read the page, to find and restore collapsed sections.',
  [PERM_FILE_WRITE]: 'Collapse/Expand needs to add, change, and remove content on the page, to collapse, expand, and rename sections.',
};

// Deliberately does NOT call PluginManager.hasPermission as a pre-check:
// its return shape is undocumented, and (B-015) it was observed treating
// an already-revoked permission as granted — every other SDK call in this
// codebase resolves to a {success,result} object, and `if (hasRes)` on an
// object is always truthy regardless of the real state. requestPermission's
// 0/1/2 result is the only permission signal SDK_DOC.md actually confirms,
// so it's the only one this trusts. Logged via console.error (not the
// DEBUG-gated dlog) because a silent failure here is exactly the "looks
// like the button doing nothing" trap CORNER_CASES.md warns about.
export async function ensurePermissions(
  names: string[],
  message: string,
  opts: { silent?: boolean } = {},
): Promise<boolean> {
  dlog(`${LOG} B-016-PROBE ensurePermissions ENTER names=${JSON.stringify(names)} granted=${JSON.stringify([...GRANTED])}`);
  for (const name of names) {
    if (GRANTED.has(name)) {
      dlog(`${LOG} B-016-PROBE ${name} already cached granted, skipping`);
      continue;
    }
    try {
      dlog(`${LOG} B-016-PROBE requestPermission CALL ${name} t=${Date.now()}`);
      const reqRes: any = await PluginManager.requestPermission(name, PERMISSION_DESCRIPTIONS[name] ?? message);
      dlog(`${LOG} B-016-PROBE requestPermission RETURNED ${name} reqRes=${JSON.stringify(reqRes)} t=${Date.now()}`);
      if (reqRes === 1 || reqRes === 2) {
        GRANTED.add(name);
        continue;
      }
      console.error(`${LOG} permission denied: ${name} (result=${reqRes})`);
    } catch (e) {
      console.error(`${LOG} permission request threw for ${name}: ${e}`);
    }
    if (!opts.silent) alert(message);
    dlog(`${LOG} B-016-PROBE ensurePermissions EXIT false`);
    return false;
  }
  dlog(`${LOG} B-016-PROBE ensurePermissions EXIT true`);
  return true;
}

// Every operation needs some subset of read/write. Asking for both
// together — rather than each operation's own minimal subset — means the
// very first time the user does anything at all (a tap, or any button
// operation, whichever comes first), they're asked once for everything,
// instead of discovering a new permission need with each new operation they
// try later. Cheap to call from every gate: already-granted names are
// skipped (see GRANTED above), so only whatever's still missing is asked.
export async function ensureAllPermissions(message: string, opts: { silent?: boolean } = {}): Promise<boolean> {
  return ensurePermissions([PERM_FILE_READ, PERM_FILE_WRITE], message, opts);
}
