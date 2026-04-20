import { PluginCommAPI, PluginNoteAPI } from 'sn-plugin-lib';
import { readUserData } from './utils/userDataManager';
import { collapseAction } from './logic/collapseAction';
import { expandAction } from './logic/expandAction';
import { recollapseAction } from './logic/recollapseAction';
import { CollapseSection, BorderUserData } from './model/types';

export async function handleMainAction() {
  try {
    // 1. Show "Processing…" indicator (can be a toast if API exists)

    // 2. Get lassoed elements
    const elementsRes = await PluginCommAPI.getLassoElements();
    if (!elementsRes.success || !elementsRes.result || elementsRes.result.length === 0) {
      alert("Please make a selection first");
      return;
    }

    const elements = elementsRes.result;
    let managedIcon: { section: CollapseSection, uuid: string } | null = null;

    // 3. Context Detection
    for (const el of elements) {
      const data = readUserData(el);
      if (data) {
        if (data.schemaVersion) {
          // Found a "+" icon element
          managedIcon = { section: data as CollapseSection, uuid: el.uuid };
          break;
        } else if (data.type === 'collapseExpandBorder') {
          // Found a border element
          const borderData = data as BorderUserData;
          // Locate the icon element by UUID
          const iconElRes = await PluginNoteAPI.getElement(borderData.iconElementUuid);
          if (iconElRes.success && iconElRes.result) {
            const iconData = readUserData(iconElRes.result);
            if (iconData) {
              managedIcon = { section: iconData as CollapseSection, uuid: borderData.iconElementUuid };
            }
            iconElRes.result.recycle();
          }
          if (managedIcon) break;
        }
      }
    }

    // 4. Dispatch to flows
    if (managedIcon) {
      if (managedIcon.section.isExpanded) {
        // FLOW 3: Collapse Again
        await recollapseAction(managedIcon.section, managedIcon.uuid);
      } else {
        // FLOW 2: Expand
        await expandAction(managedIcon.section, managedIcon.uuid);
      }
    } else {
      // FLOW 1: Fresh Collapse
      await collapseAction();
    }

    // 5. Cleanup
    for (const el of elements) {
      el.recycle();
    }

  } catch (error) {
    console.error("Plugin action failed:", error);
    alert("An error occurred during processing.");
  }
}
