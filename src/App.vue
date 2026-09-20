<script setup>
import { RouterLink, RouterView } from 'vue-router';
</script>

<template>
  <section class="App__vue">
    <header class="theNav">
      <div class="wrapper">
        <nav>
          <RouterLink to="/" aria-label="Home">
            <span class="fresh-rolling-text" aria-hidden="true">
              <span class="fresh-rolling-text-copy">Home</span>
              <span class="fresh-rolling-text-copy fresh-rolling-text-copy--incoming">Home</span>
            </span>
          </RouterLink>
          <RouterLink to="/dtwin" aria-label="DTwin">
            <span class="fresh-rolling-text" aria-hidden="true">
              <span class="fresh-rolling-text-copy">DTwin</span>
              <span class="fresh-rolling-text-copy fresh-rolling-text-copy--incoming">DTwin</span>
            </span>
          </RouterLink>
        </nav>
      </div>
    </header>

    <RouterView class="tag__RouterView" />
  </section>
</template>

<style scoped>
.App__vue {
  display: flex;
  min-height: 100vh;
}

.theNav {
  width: 200px;
  background: var(--color-bg-dark);
  color: white;
}

nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 24px 12px;
}

nav a {
  display: block;
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
}
</style>
