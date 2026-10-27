<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, RouterView, useRouter } from 'vue-router';
import SiriWave from 'siriwave';

const router = useRouter();
const routes = router.options.routes;

/* 移动端抽屉菜单开关 */
const isMenuOpen = ref(false);

/* 版本号：从 package.json 读取（vite.config.js 注入 VITE_VERSION），与 index.html 同源 */
const APP_VERSION = import.meta.env.VITE_VERSION;

/* ---- 底部头像区：随机切换（原作 fangxuecong.com 的 comming_soon 移植版）----
 * 四张头像 head0-3，暗色底上按随机间隔轮播亮出一张；
 * 资源在 src/assets/head，import 后走 Vite 指纹打包 */
const headImgs = Object.values(
  import.meta.glob('./assets/head/head*.png', {
    eager: true,
    import: 'default',
  }),
);
const headIndex = ref(-1);
let headTimer = null;

function scheduleHeadSwap() {
  headTimer = setTimeout(
    () => {
      // 排除当前张，保证每次切换都换图（否则随机撞号 = 视觉空转）
      if (headImgs.length > 1) {
        let next;
        do {
          next = Math.floor(Math.random() * headImgs.length);
        } while (next === headIndex.value);
        headIndex.value = next;
      }
      scheduleHeadSwap();
    },
    300 + Math.random() * 2700,
  ); // 0.3~3s 随机切换
}

/* 首张立即亮出（避免载入后头像区空缺 0.8~3s），此后随机轮换 */
function startHeadShow() {
  headIndex.value = Math.floor(Math.random() * headImgs.length);
  scheduleHeadSwap();
}

/* ---- get in touch：hover 显示简历 PDF，点击新窗口打开 ---- */
const pdfUrl = '/15915940450.pdf';

/* ---- Siri 波：侧栏底部氛围动画（siriwave 库，ios9 风格）---- */
const waveHost = ref(null);
let siriWave = null;
let waveVisible = true; // IntersectionObserver 结果缓存，与抽屉开合做与运算

function updateWaveRun() {
  // 抽屉关着（移动端）或滚出视口时暂停 raf，省电
  const drawerOpen = isMenuOpen.value;
  if (waveVisible && (drawerOpen || window.innerWidth >= 768)) {
    siriWave?.start();
  } else {
    siriWave?.stop();
  }
}

let headObserver = null;

onMounted(() => {
  if (headImgs.length) {
    startHeadShow();
  }
  if (waveHost.value) {
    siriWave = new SiriWave({
      container: waveHost.value,
      // classic | ios9
      style: 'ios9',
      width: 200, // 铺满链接容器（桌面侧栏宽 200px）
      height: 69,
      speed: 0.1,
      amplitude: 0.8,
      autostart: false,
      color: '#fbd509', // 主题黄，匹配站点色板
    });
    siriWave.start();
    // 视口外暂停
    headObserver = new IntersectionObserver((entries) => {
      waveVisible = entries[0].isIntersecting;
      updateWaveRun();
    });
    headObserver.observe(waveHost.value);
  }
  window.addEventListener('resize', updateWaveRun);
  // 页面切到后台：暂停头像轮换（后台 timer 被浏览器节流，切回时会
  // 连跳多张，直接停掉更干净），回前台再续
  document.addEventListener('visibilitychange', onVisibilityChange);
});

function onVisibilityChange() {
  if (document.hidden) {
    clearTimeout(headTimer);
    headTimer = null;
  } else if (headImgs.length) {
    scheduleHeadSwap();
  }
}

onBeforeUnmount(() => {
  clearTimeout(headTimer);
  headObserver?.disconnect();
  window.removeEventListener('resize', updateWaveRun);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  siriWave?.dispose();
  siriWave = null;
});

/* 抽屉开合联动波动画 */
watch(isMenuOpen, (open) => {
  document.body.style.overflow = open ? 'hidden' : '';
  updateWaveRun();
});
</script>

<template>
  <section class="App__vue">
    <!-- 移动端：悬空汉堡按钮，三线 / 叉切换 -->
    <button
      class="menu-toggle"
      :class="{ 'is-open': isMenuOpen }"
      type="button"
      :aria-expanded="isMenuOpen"
      aria-controls="mobile-drawer"
      aria-label="菜单"
      @click="isMenuOpen = !isMenuOpen"
    >
      <span class="menu-toggle-bar"></span>
      <span class="menu-toggle-bar"></span>
      <span class="menu-toggle-bar"></span>
    </button>

    <!-- 移动端：遮罩 -->
    <Transition name="menu-fade">
      <div
        v-if="isMenuOpen"
        class="menu-overlay"
        @click="isMenuOpen = false"
      ></div>
    </Transition>

    <header
      id="mobile-drawer"
      class="theNav"
      :class="{ 'is-open': isMenuOpen }"
    >
      <div class="wrapper">
        <nav>
          <RouterLink
            v-for="route in routes"
            :key="route.name"
            :to="route.path"
            :aria-label="route.zh"
            @click="isMenuOpen = false"
          >
            <!-- Home 项：站标 + 文字并排 -->
            <img
              v-if="route.name === 'home'"
              class="nav-logo"
              src="/logo.svg"
              alt=""
            />
            <span class="fresh-rolling-text" aria-hidden="true">
              <span class="fresh-rolling-text-copy">{{ route.zh }}</span>
              <span
                class="fresh-rolling-text-copy fresh-rolling-text-copy--incoming"
                >{{ route.zh }}</span
              >
            </span>
          </RouterLink>
        </nav>
        <section>
          <div class="nav-extra">
            <!-- 头像随机切换（原作 comming_soon 移植） -->
            <div class="head-stage">
              <img
                class="head-img"
                :src="headImgs[headIndex]"
                alt=""
                :class="{ visible: headIndex >= 0 }"
              />
            </div>
            <!-- get in touch：Siri 波作背景，文字居中叠在波形上；
                 hover 翻面：get in touch 滚出，15915940450.pdf 滚入 -->
            <a
              ref="waveHost"
              class="get-in-touch"
              :href="pdfUrl"
              target="_blank"
              rel="noopener noreferrer"
              title="下载我的简历"
            >
              <span class="git-rolling" aria-hidden="true">
                <span class="git-text">get in touch</span>
                <span class="git-text git-text--incoming">15915940450.pdf</span>
              </span>
              <span class="sr-only">get in touch（打开简历 PDF）</span>
            </a>
          </div>
          <p class="nav-version">v{{ APP_VERSION }}</p>
        </section>
      </div>
    </header>

    <RouterView class="tag__RouterView" />
  </section>
</template>

<style scoped>
/* 預設：移動端 <768px，手機 */

.App__vue {
  display: flex;
  /* dvh：移动端按实际可视高度，避免地址栏高差撑出整页滚动（vh 为旧浏览器兜底） */
  min-height: 100vh;
  min-height: 100dvh;
}

/* ---- 抽屉菜单（模仿 github.com 顶部导航交互）----
 * 悬空汉堡按钮固定左上角（三线，打开后动画变叉）；
 * 侧栏默认移出屏幕左侧，打开时滑入；
 * 半透明遮罩盖住内容，点击遮罩关闭
 */
.menu-toggle {
  position: fixed;
  top: 12px;
  left: 12px;
  z-index: 101;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 5px;
  width: 44px;
  height: 44px;
  padding: 10px;
  border: 1px solid var(--color-border-indarkbg);
  border-radius: 6px;
  background: var(--color-bg-dark);
  cursor: pointer;
  transition: transform 0.3s ease;
}

/* 打开（X 状态）时按钮平移到抽屉内右上角，避免盖住第一项 HOME
 * 172px = 抽屉宽 240 - 右边距 44 - 左偏移 12 */
.menu-toggle.is-open {
  transform: translateX(172px);
}

.menu-toggle-bar {
  display: block;
  width: 100%;
  height: 2px;
  border-radius: 2px;
  background: white;
  transition:
    transform 0.3s ease,
    opacity 0.2s ease;
}

/* 三线 → 叉 */
.menu-toggle.is-open .menu-toggle-bar:nth-child(1) {
  transform: translateY(7px) rotate(45deg);
}

.menu-toggle.is-open .menu-toggle-bar:nth-child(2) {
  opacity: 0;
}

.menu-toggle.is-open .menu-toggle-bar:nth-child(3) {
  transform: translateY(-7px) rotate(-45deg);
}

.menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 99;
  background: rgba(255, 255, 255, 0.8);
}

/* 遮罩淡入淡出 */
.menu-fade-enter-active,
.menu-fade-leave-active {
  transition: opacity 0.3s ease;
}

.menu-fade-enter-from,
.menu-fade-leave-to {
  opacity: 0;
}

/* 侧栏：移动端为抽屉，默认移出屏幕左侧 */
.theNav {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 100;
  width: 240px;
  background: var(--color-bg-dark);
  color: white;
  height: 100vh;
  height: 100dvh;
  overflow: auto;
  transform: translateX(-100%);
  transition: transform 0.3s ease;
}

.theNav.is-open {
  transform: translateX(0);
}

/* wrapper 撑满侧栏高度，nav flex:1 把版本号推到底部 */
.wrapper {
  display: flex;
  flex-direction: column;
  height: 100%;
}

nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 24px 12px;
  flex: 1;
}

/* 版本号：抽屉底部，暗色低对比，不抢导航注意力 */
.nav-version {
  margin: 0;
  padding: 12px 28px 20px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.35);
  font-variant-numeric: tabular-nums;
}

/* ---- 侧栏底部：头像轮播 + Siri 波 + get in touch ----
 * 原作 fangxuecong.com 页脚 comming_soon 区的移植版 */
.nav-extra {
  padding: 8px 16px 4px;
  border-top: 1px solid var(--color-border-indarkbg);
  border-bottom: 1px solid var(--color-border-indarkbg);
}

/* 头像舞台：固定尺寸防切换跳动；图淡入淡出（随机间隔由 JS 驱动）
 * PC 60px / 移动端 40px */
.head-stage {
  position: relative;
  height: 66px;
  width: 66px;
  margin: 0 auto 4px; /* 块级舞台水平居中（缩为固定尺寸后不再撑满整行） */
  overflow: hidden;
}

.head-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  opacity: 0;
  transition: opacity 0.45s ease;
}

.head-img.visible {
  opacity: 1;
}

@media (max-width: 767px) {
  .head-stage {
    height: 44px;
    width: 44px;
  }
}

/* Siri 波直接画进 get in touch 链接容器：siriwave 往 container 里插
 * canvas（width 200×height 56，非 cover 模式），CSS 同尺寸钉在容器
 * 底缘——波的中轴（heightMax = h/2-6）即视觉重心贴近链接下边缘，
 * 文字 span 居中叠在波形上 */
.get-in-touch {
  position: relative;
  display: flex;
  align-items: flex-end; /* 文字贴底，与 canvas 底缘（波谷基线）对齐 */
  justify-content: center;
  height: 56px;
  margin-bottom: 6px;
  overflow: hidden;
  font-size: 13px;
  line-height: 56px; /* 行高等于容器高：flex-end 下基线压住底缘 */
  color: rgba(255, 255, 255, 0.85);
  text-decoration: none;
  transition: color 0.3s ease;
}

.get-in-touch :deep(canvas) {
  position: absolute;
  left: 0;
  bottom: 0; /* canvas 底缘 = 链接底缘 */
  width: 200px;
  height: 56px;
}

.get-in-touch .git-rolling {
  position: relative; /* 压在 canvas 上方 */
  display: block;
  width: 100%; /* 铺满链接容器，文件名才不因视窗过窄被截断 */
  height: 30px; /* 单行文字高 = 翻面视窗 */
  overflow: hidden;
  pointer-events: none;
}

.get-in-touch .git-text {
  display: block;
  line-height: 30px;
  text-align: center; /* 文字居中，区别于左对齐的导航菜单 */
  white-space: nowrap;
}

/* 预备副本（PDF 文件名）：悬在视窗上方隐藏，hover 时随主副本下移滚入 */
.get-in-touch .git-text--incoming {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  transform: translateY(-100%);
}

/* hover：两份同时下移一行——当前文字滑出、文件名滚入（与导航 rolling 同款） */
.get-in-touch:hover .git-text {
  transform: translateY(100%);
  transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.get-in-touch:hover .git-text--incoming {
  transform: translateY(0);
}

.get-in-touch:hover {
  /* color: var(--color-primary); */
}

nav a {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  transition: color 0.3s ease;
  color: white;
}

nav a.router-link-active {
  color: var(--color-primary);
}

/* Home 项的站标：img 引用的外部 SVG 无法被外部 CSS 改色，
 * 白色+黄饰在深色侧栏直接可见，不做激活态变色；悬停转 45° */
.nav-logo {
  flex: none;
  width: 28px;
  height: 28px;
  transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* 激活态与悬停同款旋转：单一选择器列表，避免两条规则互相覆盖 */
nav a:hover .nav-logo,
nav a.router-link-active .nav-logo {
  transform: rotate(45deg);
}

/* ---- Rolling text 效果（motion.dev fresh-site-navigation-links）----
 * 每个链接内放两份文字：
 *   .fresh-rolling-text-copy          → 当前可见（translateY 0%）
 *   .fresh-rolling-text-copy--incoming → 预备在上方（translateY -100%）
 * 悬停时两份同时下移 100%：
 *   当前 → translateY(100%)  滑出下方
 *   预备 → translateY(0%)     滚入视野
 * 形成文字"滚动翻面"动画
 */
.fresh-rolling-text {
  display: inline-block;
  position: relative;
  overflow: hidden;
  vertical-align: bottom;
}

.fresh-rolling-text-copy {
  display: block;
  transform: translateY(0);
  white-space: nowrap;
}

/* 预备副本：绝对定位在容器顶部，初始上移 100% 隐藏 */
.fresh-rolling-text-copy--incoming {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  transform: translateY(-100%);
}

/* 悬停：当前副本下移 100% 滑出（transition 只写在悬停态，移出时无动画立即复位） */
nav a:hover .fresh-rolling-text-copy {
  transform: translateY(100%);
  transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* 悬停：预备副本下移至 0% 滚入（必须在上一条之后，同等特异性靠源序胜出） */
nav a:hover .fresh-rolling-text-copy--incoming {
  transform: translateY(0);
}

.tag__RouterView {
  flex: 1;
  background: #fff;
  width: 100%;
}

/* 桌面端 ≥768px：常驻侧栏，隐藏汉堡与遮罩 */
@media (min-width: 768px) {
  .menu-toggle,
  .menu-overlay {
    display: none;
  }

  .theNav {
    position: static;
    width: 200px;
    transform: none;
    transition: none;
  }

  .tag__RouterView {
    width: auto;
  }
}
</style>
