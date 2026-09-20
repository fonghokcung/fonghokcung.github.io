import { createRouter, createWebHistory } from 'vue-router';
import HomeView from '../views/HomeView.vue';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      zh: 'Home',
      component: HomeView,
    },
    {
      path: '/dtwin',
      name: 'dtwin',
      zh: 'DTwin',
      // route level code-splitting
      // this generates a separate chunk (DTwin.[hash].js) for this route
      // which is lazy-loaded when the route is visited.
      component: () => import('../views/DTwin.vue'),
    },
    {
      path: '/earth',
      name: 'earth',
      zh: 'The Earth',
      component: () => import('../views/TheEarth.vue'),
    },
  ],
});

export default router;
