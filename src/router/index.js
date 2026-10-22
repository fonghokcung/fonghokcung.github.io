import { createRouter, createWebHistory } from 'vue-router';
import HomeView from '@/views/HomeView.vue';

/* ===================== SEO：路由级描述 =====================
 * 站点标题统一为 SITE_TITLE（不随路由变化）；每条路由的 meta.desc 由下方
 * afterEach 写入 <head>：description、canonical、og:description、og:url。
 * 各页 title 保持一致，避免搜索结果显示成同一段摘要（描述仍然分页） */
const SITE_TITLE = 'xc | Fong Hokcung';
const DEFAULT_DESC =
  '房学聪（Fong Hokcung）的前端作品集：十年经验前端开发工程师，专注 Web 视觉化与 Three.js / WebGL。含 GPGPU 鸟群、车间数字孪生、地球可视化、粒子火焰等互动场景。';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      zh: 'Home',
      meta: { desc: DEFAULT_DESC },
      component: HomeView,
    },
    {
      path: '/dtwin',
      name: 'dtwin',
      zh: 'DTwin',
      meta: {
        desc: 'three.js 车间数字孪生：500 台设备用单个 InstancedMesh 渲染，点击设备查看实时数据、双击飞行定位、支持楼层切换。',
      },
      // route level code-splitting
      // this generates a separate chunk (DTwin.[hash].js) for this route
      // which is lazy-loaded when the route is visited.
      component: () => import('../views/DTwin.vue'),
    },
    {
      path: '/earth',
      name: 'earth',
      zh: 'The Earth',
      meta: {
        desc: '基于索引贴图与调色板纹理的 three.js 地球：GPU 拾取、国家高亮与两国对比、按日期计算的昼夜光照与匀速自转模拟。',
      },
      component: () => import('../views/TheEarth.vue'),
    },
    {
      path: '/noise',
      name: 'Noise',
      zh: '噪声山脉',
      meta: {
        desc: '柏林噪声（Perlin Noise）生成的 WebGL 噪声山脉地形：顶点位移与高度配色，实时交互查看分形地形。',
      },
      component: () => import('../views/NoiSe.vue'),
    },
    {
      path: '/flowingwater',
      name: 'FlowingWater',
      zh: '流动水波',
      meta: {
        desc: '法线贴图实现的流动水波：几何为完全平坦的平面，起伏全部来自噪声烘焙的法线贴图，配合反射与折射的实时渲染。',
      },
      component: () => import('../views/FlowingWater.vue'),
    },
    {
      path: '/lod',
      name: 'LOD',
      zh: 'LOD',
      meta: {
        desc: 'LOD（Level of Detail）性能优化演示：同一物体准备多份精度不同的模型，按相机距离自动切换，平衡画面与开销。',
      },
      component: () => import('../views/LevelofDetail.vue'),
    },
    {
      path: '/tourbox',
      name: 'tourbox',
      zh: 'tourbox',
      meta: {
        desc: 'GLTF 三维模型展示：主角模型优先加载渲染，其余配色模型并发加载后就位，含渐进式加载与首屏性能优化。',
      },
      component: () => import('../views/ToolBox.vue'),
    },
    {
      path: '/par',
      name: 'Particle',
      zh: '粒子',
      meta: {
        desc: '纯 2D Canvas 歌词滚动与化沙退出动画：《光阴的歌》歌词逐句停留后化作飞沙散尽，附背景飘雪与自适应字号排版。',
      },
      component: () => import('../views/ParticleEffe.vue'),
    },
    {
      path: '/fire',
      name: 'Fire',
      zh: 'Quarks-火焰',
      meta: {
        desc: 'three.quarks 粒子系统火焰演示：实时调节粒子数量与发射参数，观察粒子行为对画面与性能的影响。',
      },
      component: () => import('../views/QuarksFire.vue'),
    },
    {
      path: '/manUal',
      name: 'ManUal',
      zh: 'ManUal',
      meta: {
        desc: '原生 WebGL 与 three.js 双屏对比：同一渲染内容的两套实现并排展示，直观看清框架在底层做了哪些事。',
      },
      component: () => import('../views/ManUal.vue'),
    },
  ],
});

function setMeta(selector, content) {
  document.querySelector(selector)?.setAttribute('content', content);
}

/* 路由切换后同步 <head>：SPA 只有一个 index.html，不更新的话所有页面
 * 共享首页描述，搜索结果里各页会显示同一段摘要 */
router.afterEach((to) => {
  const desc = to.meta.desc || DEFAULT_DESC;
  const url = location.origin + to.path;

  document.title = SITE_TITLE;
  setMeta('meta[name="description"]', desc);
  setMeta('meta[property="og:title"]', SITE_TITLE);
  setMeta('meta[property="og:description"]', desc);
  setMeta('meta[property="og:url"]', url);
  setMeta('meta[name="twitter:title"]', SITE_TITLE);
  setMeta('meta[name="twitter:description"]', desc);
  document.querySelector('link[rel="canonical"]')?.setAttribute('href', url);
});

export default router;
