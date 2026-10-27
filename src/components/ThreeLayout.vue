<script setup>
/**
 * ThreeLayout：项目标准页面骨架 —— 左侧大 canvas 舞台 + 右侧可伸缩文案面板。
 *
 * 用法（页面只需要提供内容，布局/动画/按钮全部内置）：
 *   <ThreeLayout txt-title="标题" txt-sub="说明" txt-hint="操作提示" @stage-resize="onResize">
 *     <template #stage>...</template>   ← 可选：舞台内的 HUD/面板等悬浮层
 *   </ThreeLayout>
 *
 * 组件向页面暴露 stageRef（canvas 容器，three.js renderer appendChild 的地方），
 * 并在舞台尺寸变化时（含 txt 收起/展开的布局变化、窗口缩放）emit stage-resize 事件，
 * 页面用它驱动 renderer.setSize / 相机 aspect 等自适应逻辑。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import IconMoveRight from '@/components/icons/IconMoveRight.vue';

const emit = defineEmits(['stage-resize']);

defineProps({
  txtTitle: { type: String, default: '' },
  txtSub: { type: String, default: '' },
  txtHint: { type: String, default: '' },
});

const stageRef = ref(null);
// 面板宽度状态：
// 桌面端（≥768px）三态：初始 60（露出提示有面板）→ 点击 260（展开）→ 0（收起），
// 点过后只在 260/0 间切换；移动端（<768px，移动优先）两态：初始收起 0 ⇄ 全屏。
// 全屏态用哨兵 FULL = -1 表示、模板渲染成 100vw —— 不在 JS 里读窗口尺寸，
// 横竖屏切换后全屏态依然正确
const isDesktop = window.matchMedia('(min-width: 768px)').matches;
const FULL = -1; // 移动端全屏态哨兵
const txtWidth = ref(isDesktop ? 60 : 0);
const isExpanded = computed(
  () => txtWidth.value === 260 || txtWidth.value === FULL,
);
let resizeObserver = null;

/* ---- 舞台全屏 ----
 * 全屏目标是 stageRef（canvas 容器）：舞台内的 HUD/浮层随元素一起进全屏，
 * txt 面板在 stage 之外，全屏时自然不可见（由本按钮退出）。
 * 尺寸变化走已有的 ResizeObserver → stage-resize，页面各自的
 * renderer.setSize / 相机 aspect 无需改动。
 * fullscreenEnabled 为 false 的浏览器（老 iOS 只支持视频全屏）不渲染按钮，
 * 避免出现点了没反应的死按钮。 */
const fullscreenSupported = ref(Boolean(document.fullscreenEnabled));
const isFullscreen = ref(false);

function onFullscreenChange() {
  isFullscreen.value = document.fullscreenElement === stageRef.value;
}

function toggleFullscreen() {
  if (document.fullscreenElement === stageRef.value) {
    document.exitFullscreen();
  } else {
    // 浏览器可能在权限/策略下拒绝，静默忽略（不改变界面状态）
    stageRef.value?.requestFullscreen?.()?.catch(() => {});
  }
}

onMounted(() => {
  // 观察舞台容器本身：txt 收起/展开只改 flex 布局、不触发 window.resize，
  // 唯有 ResizeObserver 能覆盖这类布局引起的尺寸变化
  resizeObserver = new ResizeObserver((entries) => {
    const rect = entries[0].contentRect;
    if (rect.width > 0 || rect.height > 0) emit('stage-resize', rect);
  });
  resizeObserver.observe(stageRef.value);
  document.addEventListener('fullscreenchange', onFullscreenChange);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  document.removeEventListener('fullscreenchange', onFullscreenChange);
});

// 点击切换：桌面端 60(初始)→260 展开，之后 260/0 互换；移动端 0 ⇄ 全屏
function toggleTxt() {
  if (!isDesktop) {
    txtWidth.value = txtWidth.value === FULL ? 0 : FULL;
    return;
  }
  txtWidth.value = txtWidth.value === 260 ? 0 : 260;
}

defineExpose({ stageRef, txtWidth });
</script>

<template>
  <div class="three-layout">
    <div ref="stageRef" class="stage">
      <!-- 页面级悬浮层：HUD、数据面板、标签层等 -->
      <slot name="stage" />

      <!-- 舞台左下角全屏按钮：所有使用本骨架的页面（首页除外）自动具备。
           全屏时图标切为「向内收拢」形态，点击退出。
           hover 效果（motion.dev fresh-primary-action 原版手法）：
           ::before 斜切面经 clip-path 多边形插值，从左上向右下滑入 -->
      <button
        v-if="fullscreenSupported"
        class="stage-fullscreen"
        :title="isFullscreen ? '退出全屏' : '全屏'"
        :aria-label="isFullscreen ? '退出全屏' : '全屏'"
        @click="toggleFullscreen"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <!-- 未全屏：四角向外 -->
          <path
            v-if="!isFullscreen"
            d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"
          />
          <!-- 已全屏：四角向内 -->
          <path v-else d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
        </svg>
      </button>
    </div>

    <section
      class="txt"
      :style="{ width: txtWidth === FULL ? '100vw' : txtWidth + 'px' }"
    >
      <div class="txt-body">
        <slot>
          <h1 class="txt-title">{{ txtTitle }}</h1>
          <p v-if="txtSub" class="txt-sub">{{ txtSub }}</p>
          <p v-if="txtHint" class="txt-hint">{{ txtHint }}</p>
        </slot>
      </div>
    </section>

    <!-- 收起/展开按钮：骑在面板左边缘。
         箭头：展开态(260)朝右，初始露出态(60)与收起态(0)朝左（点击均展开）；
         位置：仅宽度 0 时收进右缘 -->
    <button
      class="txt-toggle"
      :class="{
        mirror: !isExpanded,
        collapsed: txtWidth === 0,
        fullscreen: txtWidth === FULL,
      }"
      :style="{ right: txtWidth === FULL ? '100vw' : txtWidth + 'px' }"
      :title="isExpanded ? '收起说明' : '展开说明'"
      :aria-label="isExpanded ? '收起说明' : '展开说明'"
      @click="toggleTxt"
    >
      <!-- lucide move-right 图标：mirror 时 transform scaleX(-1) 朝左 -->
      <IconMoveRight />
    </button>
  </div>
</template>

<style scoped>
.three-layout {
  position: relative; /* 收起/展开按钮以此为锚点 */
  display: flex; /* 横向：左 canvas，右文案 */
  align-items: stretch;
  /* dvh：移动端按实际可视高度铺满，避免地址栏高差导致的整页滚动（vh 为旧浏览器兜底） */
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
}

/* ---- 舞台：尽可能大，吃掉除文案面板外的全部空间 ---- */
.stage {
  position: relative; /* 悬浮层/stats 以它为锚点 */
  z-index: 1;
  flex: 1;
  min-width: 0;
  min-height: 200px;
  overflow: hidden;
}

.stage :deep(canvas) {
  display: block;
}

/* ---- 左下角全屏按钮：占的是各页面都没用到的空位 ----
 * z-index 30：高于各页 HUD（10/20），保证可点；左下角本身无其他浮层 */
.stage-fullscreen {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 30;
  width: 36px;
  height: 36px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #e6edf3;
  background: rgba(20, 30, 45, 0.72);
  border: 1px solid rgba(230, 237, 243, 0.3);
  border-radius: 6px;
  cursor: pointer;
  backdrop-filter: blur(4px);
  overflow: hidden; /* 裁剪斜切面滑入时超出按钮的部分 */
}

/* hover 斜切面（motion.dev fresh-primary-action 原版手法）：
 * ::before 充当「hover 面」，静止时 clip-path 裁成左缘零面积碎片，
 * hover 时多边形顶点插值——右边界从顶部 200% 斜插到 100%，
 * 呈现左上 → 右下的对角滑入。clip-path 过渡由 GPU 合成，
 * 比宽高/位移类动画更顺滑 */
.stage-fullscreen::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--color2); /* 电光蓝：主题彩蛋色，全站统一 */
  clip-path: polygon(-1% 0%, -1% 0%, -100% 100%, -1% 100%);
  transition: clip-path 0.4s cubic-bezier(0.25, 0, 0, 1);
}

.stage-fullscreen:hover {
  border-color: transparent; /* 斜切面盖满后边框融进蓝底 */
}

.stage-fullscreen:hover::before {
  clip-path: polygon(0% 0%, 200% 0%, 100% 100%, 0% 100%);
}

.stage-fullscreen svg {
  position: relative;
  z-index: 1; /* 图标压在斜切面之上 */
  width: 16px;
  height: 16px;
}

/* ---- 右侧文案说明（宽度由 txtWidth 内联驱动：
     桌面 60 初始 / 260 展开 / 0 收起；移动端 0 ⇄ 100vw 全屏） ---- */
.txt {
  position: relative; /* 让面板形成可设层级的定位上下文 */
  z-index: 10; /* 高于 stage，面板内 tooltip 才能盖过 canvas */
  flex-shrink: 0;
  background: var(--color-bg);
  color: #000;
  border-left: 2px solid #333;
  transition: width 0.25s ease;
  overflow-y: auto; /* 文案超出面板高度时显示竖向滚动条（长文案页必需） */
  /* overflow-y 设为 auto 后 overflow-x 按规范同步变 auto；
   * 内层 .txt-body 固定 260px，在露出态(60px)/滚动条挤占宽度时会横向溢出
   * → 显式禁掉横向滚动，超出部分裁剪 */
  overflow-x: hidden;
}

/* 固定内边距放在内层：宽度动画时文字内容不被挤压换行 */
.txt-body {
  /* 預設（移动端）：全屏态文本列居中。列宽钳到 260px，但两侧各留 ≥64px——
   * 左上角汉堡按钮右缘在 56px（12 + 44），窄屏(≤371px)时 260px 居中列
   * 的首行会被盖住，min() 收窄列宽避开它 */
  width: min(260px, calc(100vw - 128px));
  padding: 12px;
  /* 全屏态下文本列居中，避免右侧大片留白；
   * 面板窄于列宽时（收起/过渡中）auto margin 解析为 0，仍靠左 */
  margin: 0 auto;
}

/* 桌面端 ≥768px：无汉堡按钮，面板即 260px，文本列固定宽靠左 */
@media (min-width: 768px) {
  .txt-body {
    width: 260px;
    margin: 0;
  }
}

/* 文案元素由默认 slot 提供（父组件作用域），必须 :deep() 穿透才能命中 */
.txt-body :deep(.txt-title) {
  font-size: 15px;
  font-weight: bold;
  color: #000;
}

.txt-body :deep(.txt-sub) {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.7;
  color: #000;
}

.txt-body :deep(.txt-hint) {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px dashed #000;
  font-size: 10px;
  line-height: 1.8;
  color: #000;
}

/* 链接型 hint：跟随全局链接色 --color2（特异性高于上面的 .txt-hint 才能覆盖黑色）。
 * 普通 <p class="txt-hint"> 提示文字仍保持黑色 */
.txt-body :deep(a.txt-hint) {
  color: var(--color2);
}

/* ---- 收起/展开圆形按钮 ---- */
.txt-toggle {
  position: absolute;
  top: 50%;
  right: 260px; /* 展开态 = 面板宽度，即面板左缘 */
  z-index: 30;
  width: 26px;
  height: 26px;
  color: #333;
  background: #fff;
  border: 2px solid #333;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transform: translate(50%, -50%); /* 半个身位压在场景上 */
  transition:
    right 0.25s ease,
    transform 0.25s ease;
}

/* 收起态：面板宽度为 0，按钮整体收进右缘内保持可见 */
.txt-toggle.collapsed {
  right: 0;
  transform: translate(0, -50%);
}

/* 移动端全屏态：面板盖满屏幕，right:100vw 会把按钮锚到屏幕左缘外。
 * transform 平移一个身位（100%）把按钮完整收回屏幕内——
 * 骑在面板左缘、垂直居中，始终可点按收起 */
.txt-toggle.fullscreen {
  transform: translate(100%, -50%);
}

/* 图标：展开态(260)箭头朝右；mirror（初始 60 / 收起 0）scaleX(-1) 朝左 */
.txt-toggle svg {
  width: 14px;
  height: 14px;
  transition: transform 0.25s ease;
}

.txt-toggle.mirror svg {
  transform: scaleX(-1);
}
</style>
