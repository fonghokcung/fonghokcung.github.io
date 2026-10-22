<script setup>
import { ref, watch } from 'vue';
import { RouterLink, RouterView, useRouter } from 'vue-router';

const router = useRouter();
const routes = router.options.routes;

/* 移动端抽屉菜单开关 */
const isMenuOpen = ref(false);

/* 版本号：从 package.json 读取（vite.config.js 注入 VITE_VERSION），与 index.html 同源 */
const APP_VERSION = import.meta.env.VITE_VERSION;

/* 抽屉打开时锁定背景滚动 */
watch(isMenuOpen, (open) => {
  document.body.style.overflow = open ? 'hidden' : '';
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
        <p class="nav-version">v{{ APP_VERSION }}</p>
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
