<script setup>
/* 通用问号 tooltip（Element Plus 同思路的轻量版）：
 * popup 通过 <Teleport to="body"> 插到 document.body 下，彻底脱离
 * 任何 overflow:hidden / transform 祖先的裁剪上下文；
 * 显示时用 getBoundingClientRect 读取触发元素在视口中的位置，
 * 以 position:fixed + transform 定位 popup（默认出现在下方居中，
 * 自动防视口溢出：左右 clamp、空间不足时翻转到上方）。
 * 滚动/窗口尺寸变化时若 popup 打开则重算位置 */
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

defineProps({
  /* popup 文本（纯文本即可，复杂结构请改用 slot） */
  text: { type: String, required: true },
  /* 触发图标文字 */
  label: { type: String, default: '?' },
});

const triggerRef = ref(null);
const visible = ref(false);
/* fixed 定位坐标：top/left 归零，实际位置全走 transform（合成层，不触发 reflow） */
const pos = ref({ x: 0, y: 0 });
/* 翻转标记：true = popup 显示在触发元素上方 */
const flipped = ref(false);

const GAP = 6; // popup 与触发元素的间距
const VIEWPORT_MARGIN = 8; // 距视口边缘的最小留白

/* 依据触发元素位置计算 popup 的 fixed 坐标 */
function updatePosition() {
  const trigger = triggerRef.value;
  if (!trigger || !visible.value) return;
  const rect = trigger.getBoundingClientRect();
  const pop = document.querySelector('.tip-popup');
  const popW = pop ? pop.offsetWidth : 200;
  const popH = pop ? pop.offsetHeight : 60;

  // 水平：中心对齐触发元素，左右 clamp 到视口内
  let x = rect.left + rect.width / 2 - popW / 2;
  x = Math.max(
    VIEWPORT_MARGIN,
    Math.min(x, window.innerWidth - popW - VIEWPORT_MARGIN),
  );

  // 垂直：默认下方；下方放不下且上方放得下则翻转
  let y = rect.bottom + GAP;
  flipped.value = false;
  if (
    y + popH > window.innerHeight - VIEWPORT_MARGIN &&
    rect.top - GAP - popH >= VIEWPORT_MARGIN
  ) {
    y = rect.top - GAP - popH;
    flipped.value = true;
  }
  pos.value = { x, y };
}

function show() {
  visible.value = true;
  // 等 popup 渲染进 DOM（Teleport 到 body）后再量尺寸定位
  nextTick(updatePosition);
}

function hide() {
  visible.value = false;
}

onMounted(() => {
  // 打开期间滚动/缩放跟随（scroll 用 capture 捕获任意滚动容器的滚动）
  window.addEventListener('resize', updatePosition);
  window.addEventListener('scroll', updatePosition, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', updatePosition);
  window.removeEventListener('scroll', updatePosition, true);
});
</script>

<template>
  <span
    ref="triggerRef"
    class="tip-badge"
    tabindex="0"
    role="button"
    :aria-label="text"
    @mouseenter="show"
    @mouseleave="hide"
    @focus="show"
    @blur="hide"
    >{{ label }}</span
  >
  <Teleport to="body">
    <Transition name="tip-fade">
      <span
        v-if="visible"
        class="tip-popup"
        :class="{ 'tip-popup--flipped': flipped }"
        :style="{ transform: `translate(${pos.x}px, ${pos.y}px)` }"
        role="tooltip"
        >{{ text }}</span
      >
    </Transition>
  </Teleport>
</template>

<style>
/* 注意：popup Teleport 到 body 之下，scoped 样式够不着，
 * 这里用全局样式 + 专用类名（.tip-popup 全站仅此组件生成） */
.tip-badge {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 13px;
  height: 13px;
  margin: 0 2px;
  font-size: 9px;
  color: var(--color3);
  cursor: help;
  border: 1px solid var(--color3);
  border-radius: 50%;
  user-select: none;
}

.tip-popup {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 2000; /* 盖过页面任何层叠上下文 */
  width: 200px;
  padding: 6px 8px;
  font-size: 10px;
  line-height: 1.5;
  color: #fff;
  background: var(--color3);
  border-radius: 5px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
  pointer-events: none; /* 纯展示：不拦鼠标，mouseleave 即时生效 */
}

/* 翻转到上方时给个小箭头观感（简单圆角即可，不加三角） */
.tip-popup--flipped {
  transform-origin: bottom center;
}

.tip-fade-enter-active,
.tip-fade-leave-active {
  transition: opacity 0.15s;
}
.tip-fade-enter-from,
.tip-fade-leave-to {
  opacity: 0;
}
</style>
