/**
 * @format
 */

import {AppRegistry, Image} from 'react-native';
import {name as appName} from './app.json';
import App from './App';
import {handleMainAction} from './src/index';
import {onMotionDown, onMotionUp} from './src/logic/iconMoveRedraw';
import {onTapDown, onTapUp} from './src/logic/iconTapToggle';
import {PluginManager} from 'sn-plugin-lib';
import {BUILD_TAG, LOG, PLUGIN_BUTTON_NAME, PLUGIN_MENU_ID} from './src/constants';

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();
console.log(`${LOG} PluginManager.init() called`);

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
  res => console.log(`${LOG} registerButton resolved:`, res),
  err => console.log(`${LOG} registerButton rejected:`, err),
);

PluginManager.registerButtonListener({
  onButtonPress: event => {
    console.log(
      `${LOG} onButtonPress fired. event=${JSON.stringify(event)} ` +
        `expected id=${PLUGIN_MENU_ID} name=${PLUGIN_BUTTON_NAME}`,
    );
    if (event?.id === PLUGIN_MENU_ID && event?.name === PLUGIN_BUTTON_NAME) {
      console.log(`${LOG} match -> calling handleMainAction`);
      handleMainAction();
    } else {
      console.log(`${LOG} event did not match expected id/name, ignoring`);
    }
  },
});
console.log(`${LOG} registerButtonListener called`);

// Live-redraw a section when its + icon is dragged (iconMoveRedraw), and toggle
// a section when its + icon is tapped (iconTapToggle). Only DOWN (0) and UP (1)
// matter; ignore MOVE (2) / CANCEL (3).
try {
  PluginManager.registerMotionListener(1, {
    onMsg: m => {
      const a = m?.action;
      if (a === 0) {
        onMotionDown(m?.x, m?.y);
        onTapDown(m?.x, m?.y, m?.toolType, m?.pointerCount);
      } else if (a === 1) {
        onMotionUp(m?.x, m?.y);
        onTapUp(m?.x, m?.y, m?.toolType, m?.pointerCount);
      }
    },
  });
  console.log(`${LOG} registerMotionListener (live redraw + tap toggle) called build=${BUILD_TAG}`);
} catch (e) {
  console.log(`${LOG} registerMotionListener threw: ${e}`);
}
