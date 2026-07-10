import { createApp } from 'vue';
import SidebarApp from './SidebarApp.vue';
import '../theme/tokens.css';
import '../theme/motion/dialog.css';
import '../theme/motion/message.css';
import '../theme/motion/collapse.css';
import './sidebar.css';

createApp(SidebarApp).mount('#sidebar-app');
