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
import { onBeforeUnmount, onMounted, ref } from 'vue';
import IconMoveRight from '@/components/icons/IconMoveRight.vue';

const emit = defineEmits(['stage-resize']);

defineProps({
  txtTitle: { type: String, default: '' },
  txtSub: { type: String, default: '' },
  txtHint: { type: String, default: '' },
});

const stageRef = ref(null);
const txtCollapsed = ref(true); // 默认收起：进入页面先看场景，需要说明再展开
let resizeObserver = null;

onMounted(() => {
  // 观察舞台容器本身：txt 收起/展开只改 flex 布局、不触发 window.resize，
  // 唯有 ResizeObserver 能覆盖这类布局引起的尺寸变化
  resizeObserver = new ResizeObserver((entries) => {
    const rect = entries[0].contentRect;
    if (rect.width > 0 || rect.height > 0) emit('stage-resize', rect);
  });
  resizeObserver.observe(stageRef.value);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});

defineExpose({ stageRef, txtCollapsed });
</script>

<template>
  <div class="three-layout">
    <div ref="stageRef" class="stage">
      <!-- 页面级悬浮层：HUD、数据面板、标签层等 -->
      <slot name="stage" />
    </div>

    <section class="txt" :class="{ collapsed: txtCollapsed }">
      <div class="txt-body">
        <slot>
          <h2 class="txt-title">{{ txtTitle }}</h2>
          <p v-if="txtSub" class="txt-sub">{{ txtSub }}</p>
          <p v-if="txtHint" class="txt-hint">{{ txtHint }}</p>
        </slot>
      </div>
    </section>

    <!-- 收起/展开按钮：骑在文案面板左边缘，展开时箭头朝右(点击收起)，收起时朝左 -->
    <button
      class="txt-toggle"
      :class="{ collapsed: txtCollapsed }"
      :title="txtCollapsed ? '展开说明' : '收起说明'"
      :aria-label="txtCollapsed ? '展开说明' : '收起说明'"
      @click="txtCollapsed = !txtCollapsed"
    >
      <!-- lucide move-right 图标：收起态用 transform 镜像成朝左 -->
      <IconMoveRight />
    </button>
  </div>
</template>

<style scoped>
.three-layout {
  position: relative; /* 收起/展开按钮以此为锚点 */
  display: flex; /* 横向：左 canvas，右文案 */
  align-items: stretch;
  height: 100vh;
  overflow: hidden;
}

/* ---- 舞台：尽可能大，吃掉除文案面板外的全部空间 ---- */
.stage {
  position: relative; /* 悬浮层/stats 以它为锚点 */
  flex: 1;
  min-width: 0;
  min-height: 200px;
  overflow: hidden;
}

.stage :deep(canvas) {
  display: block;
}

/* ---- 右侧文案说明 ---- */
.txt {
  width: 260px;
  flex-shrink: 0;
  background: var(--color-bg);
  color: #000;
  overflow: hidden;
  border-left: 2px solid #333;
  transition: width 0.25s ease;
}

/* 收起态：宽度收到 0（按钮浮在场景上，不随布局挤压） */
.txt.collapsed {
  width: 0;
}

/* 固定内边距放在内层：宽度动画时文字内容不被挤压换行 */
.txt-body {
  width: 260px;
  padding: 12px;
}

.txt-title {
  font-size: 15px;
  font-weight: bold;
  color: #000;
}

.txt-sub {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.7;
  color: #000;
}

.txt-hint {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px dashed #000;
  font-size: 10px;
  line-height: 1.8;
  color: #000;
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

/* 图标：默认箭头朝右；收起态 scaleX(-1) 镜像成朝左 */
.txt-toggle svg {
  width: 14px;
  height: 14px;
  transition: transform 0.25s ease;
}

.txt-toggle.collapsed svg {
  transform: scaleX(-1);
}
</style>
