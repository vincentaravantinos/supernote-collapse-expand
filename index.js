/**
 * @format
 */

import {AppRegistry, Image} from 'react-native';
import {name as appName} from './app.json';
import App from './App';
import {handleMainAction} from './src/index';
import {onMotionDown, onMotionUp} from './src/logic/iconMoveRedraw';
import {PluginManager} from 'sn-plugin-lib';
import {BUILD_TAG, LOG, PLUGIN_BUTTON_NAME, PLUGIN_MENU_ID} from './src/constants';

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();
console.log(`${LOG} PluginManager.init() called`);

// Position 2 = Lasso Menu
PluginManager.registerButton(2, ['NOTE'], {
  id: PLUGIN_MENU_ID,
  name: PLUGIN_BUTTON_NAME,
  icon: Image.resolveAssetSource(require('./assets/icon_plus.png')).uri,
  // editDataTypes specifies which selection element types enable this button in
  // the lasso menu. Values (per prelude-rs/sn-align-plugin): 0=stroke, 1=title,
  // 2=image, 3=text-box, 4=link, 5=geometry. Include 5 so a geometry-only
  // selection can collapse too — omitting it greyed the button out for pure
  // shapes (confirmed on-device, 2026-06), even though we serialize geometry.
  editDataTypes: [0, 1, 2, 3, 4, 5],
  showType: 0,
}).then(
  res => console.log(`${LOG} registerButton resolved:`, res),
  err => console.log(`${LOG} registerButton rejected:`, err),
);

/**
 * Listen for native button press events.
 */
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

// Live-redraw a section's box when its + icon is dragged. The motion listener
// gives us the gesture: onMotionDown gates in-memory (did a drag start on an
// expanded section's icon?), and onMotionUp redraws that section's box if the
// icon moved. Logic + state live in src/logic/iconMoveRedraw.ts. We ignore
// ACTION_MOVE (2) / CANCEL (3) — only DOWN (0) and UP (1) matter.
try {
  PluginManager.registerMotionListener(1, {
    onMsg: m => {
      const a = m?.action;
      if (a === 0) onMotionDown(m?.x, m?.y);
      else if (a === 1) onMotionUp(m?.x, m?.y);
    },
  });
  console.log(`${LOG} registerMotionListener (live redraw) called build=${BUILD_TAG}`);
} catch (e) {
  console.log(`${LOG} registerMotionListener threw: ${e}`);
}
