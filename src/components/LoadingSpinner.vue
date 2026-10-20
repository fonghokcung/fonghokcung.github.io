<template>
  <!-- GitHub 经典 loading：深色顶边圆环线性旋转 + 可选文字（项目通用加载样式） -->
  <div class="loading-spinner">
    <span class="ring" :style="ringStyle"></span>
    <p v-if="text" class="text">{{ text }}</p>
  </div>
</template>

<script setup>
/* 用法：<LoadingSpinner text="加载中…" :size="32" />
 * text 可省略；size 决定圆环直径（px），边框粗细按 size/8 自适应 */
import { computed } from 'vue';

const props = defineProps({
  text: { type: String, default: '' },
  size: { type: Number, default: 32 },
});

const ringStyle = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  borderWidth: `${Math.max(2, Math.round(props.size / 8))}px`,
}));
</script>

<style scoped>
.loading-spinner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

/* GitHub 同款：三边浅灰轨道 + 一边深色，旋转时呈现经典缺口圆环 */
.ring {
  box-sizing: border-box;
  border-style: solid;
  border-color: rgba(0, 0, 0, 0.15);
  border-top-color: rgba(0, 0, 0, 0.65);
  border-radius: 50%;
  animation: spin 0.6s infinite linear;
}

.text {
  margin: 0;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.65);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
