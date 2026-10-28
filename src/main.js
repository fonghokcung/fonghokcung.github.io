import '@/assets/main.css';

import { createApp } from 'vue';

import App from '@/App.vue';
import router from '@/router';
import { vLoading } from '@/directives/loading';

const app = createApp(App);

app.use(router);
app.directive('loading', vLoading); // 项目通用加载遮罩指令

app.mount('#app');
