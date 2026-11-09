import { boot } from './app.js';
import { createStore } from './store-firebase.js';
import { createStore as createDemoStore } from './store-demo.js';
import { firebaseConfig } from './config.js';

// No Firebase config yet -> run the on-device demo so the app still opens.
boot(firebaseConfig ? createStore : createDemoStore);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
