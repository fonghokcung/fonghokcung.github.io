import { createRouter, createWebHistory } from 'vue-router';
import HomeView from '@/views/HomeView.vue';

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
    {
      path: '/noise',
      name: 'Noise',
      zh: '噪声山脉',
      component: () => import('../views/NoiSe.vue'),
    },
    {
      path: '/flowingwater',
      name: 'FlowingWater',
      zh: '流动水波',
      component: () => import('../views/FlowingWater.vue'),
    },
    {
      path: '/lod',
      name: 'LOD',
      zh: 'LOD',
      component: () => import('../views/LevelofDetail.vue'),
    },
    {
      path: '/tourbox',
      name: 'tourbox',
      zh: 'tourbox',
      component: () => import('../views/ToolBox.vue'),
    },
    {
      path: '/par',
      name: 'Particle',
      zh: '粒子',
      component: () => import('../views/ParticleEffe.vue'),
    },
    {
      path: '/fire',
      name: 'Fire',
      zh: 'Quarks-火焰',
      component: () => import('../views/QuarksFire.vue'),
    },
    {
      path: '/manUal',
      name: 'ManUal',
      zh: 'ManUal',
      component: () => import('../views/ManUal.vue'),
    },
  ],
});

export default router;
