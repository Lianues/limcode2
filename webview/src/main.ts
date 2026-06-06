import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './theme/tokens.css';
import './theme/base.css';
import './theme/motion/message.css';
import './theme/motion/dialog.css';
import './theme/motion/dropdown.css';
import './theme/motion/content.css';
import './theme/motion/composer.css';
import './theme/motion/status.css';

const app = createApp(App);
app.use(createPinia());
app.mount('#app');
