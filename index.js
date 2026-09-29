/**
 * @format
 */

import {AppRegistry, Image} from 'react-native';
import {name as appName} from './app.json';
import App from './App';
import {handleMainAction} from './src/index';
import {onMotionDown, onMotionUp} from './src/logic/iconMoveRedraw';
import {onTapDown, onTapUp} from './src/logic/iconTapToggle';
import {rehydrateExpandedRegistry} from './src/logic/expandAction';
import {getCurrentFileContext} from './src/utils/currentFile';
import {PluginManager} from 'sn-plugin-lib';
import {BUILD_TAG, dlog, LOG, PLUGIN_BUTTON_NAME, PLUGIN_MENU_ID} from './src/constants';

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();
// Always logged: confirms which build is actually live after an install.
console.log(`${LOG} init build=${BUILD_TAG}`);

// type 2 = lasso menu.
PluginManager.registerButton(2, ['NOTE'], {
  id: PLUGIN_MENU_ID,
  name: PLUGIN_BUTTON_NAME,
  icon: Image.resolveAssetSource(require('./assets/icon_plus.png')).uri,
  // Selection element types that enable the button: 0=stroke, 1=title, 2=image,
  // 3=text-box, 4=link, 5=geometry. 5 is needed or a geometry-only selection
  // greys the button out, even though we serialize geometry.
  editDataTypes: [0, 1, 2, 3, 4, 5],
  showType: 0,
}).then(
  res => dlog(`${LOG} registerButton resolved:`, res),
  err => console.error(`${LOG} registerButton rejected:`, err),
);

PluginManager.registerButtonListener({
  onButtonPress: event => {
    dlog(`${LOG} onButtonPress fired. event=${JSON.stringify(event)}`);
    if (event?.id === PLUGIN_MENU_ID && event?.name === PLUGIN_BUTTON_NAME) {
      handleMainAction();
    }
  },
});

// Live-redraw a section when its + icon is dragged (iconMoveRedraw), and toggle
// a section when its + icon is tapped (iconTapToggle). Only DOWN (0) and UP (1)
// matter; ignore MOVE (2) / CANCEL (3).
try {
  PluginManager.registerMotionListener(1, {
    onMsg: m => {
      const a = m?.action;
      if (a === 0) {
        onMotionDown(m?.x, m?.y, m?.toolType, m?.pointerCount);
        onTapDown(m?.x, m?.y, m?.toolType, m?.pointerCount);
      } else if (a === 1) {
        onMotionUp(m?.x, m?.y, m?.toolType, m?.pointerCount);
        onTapUp(m?.x, m?.y, m?.toolType, m?.pointerCount);
      }
    },
  });
} catch (e) {
  console.error(`${LOG} registerMotionListener threw: ${e}`);
}

// Best-effort warm-up so live icon-drag redraw survives a restart: seed
// expandedRegistry (JS-memory-only) for any already-expanded section on the
// page open right now. Fire-and-forget — must not delay init.
(async () => {
  try {
    const ctx = await getCurrentFileContext();
    if (ctx) {
      await rehydrateExpandedRegistry(ctx.filePath, ctx.page);
      dlog(`${LOG} rehydrateExpandedRegistry done for page=${ctx.page}`);
    }
  } catch (e) {
    console.error(`${LOG} rehydrateExpandedRegistry threw: ${e}`);
  }
})();
