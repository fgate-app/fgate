import { createApp } from 'vue';
import App from './App.vue';
import {registerPwa} from './pwa.js';
import './style.css';
createApp(App).mount('#app');
registerPwa();

import './mobile.css';
