/**
 * @format
 */

import {AppRegistry, Image} from 'react-native';
import {name as appName} from './app.json';
import App from './App';
import {handleMainAction} from './src/index';
import {PluginManager} from 'sn-plugin-lib';
import {PLUGIN_BUTTON_NAME, PLUGIN_BUTTON_ID} from './src/constants';

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

// Position 2 = Lasso Menu
PluginManager.registerButton(2, ['NOTE'], {
  id: PLUGIN_BUTTON_ID,
  name: PLUGIN_BUTTON_NAME,
  icon: Image.resolveAssetSource(require('./assets/icon_plus.png')).uri,
  // editDataTypes specifies which elements trigger this button in the lasso menu
  editDataTypes: [0, 1, 2, 3, 4],
  showType: 1,
});

/**
 * Listen for native button press events.
 */
PluginManager.registerButtonListener({
  onButtonPress: event => {
    if (event?.id === PLUGIN_BUTTON_ID && event?.name === PLUGIN_BUTTON_NAME) {
      handleMainAction();
    }
  },
});
