<template>
  <ThreeLayout
    ref="layoutRef"
    txt-title="车间数字孪生"
    txt-sub="俯视车间地面：500 台设备用单个 InstancedMesh 渲染（drawcall 目标 < 10），点击设备弹出实时数据面板，双击相机飞过去，支持楼层切换。"
    txt-hint="左键旋转 · 右键平移 · 滚轮缩放 · 点击选设备 · 双击飞过去 · 左上角切换楼层"
    @stage-resize="onStageResize"
  >
    <!-- 舞台悬浮层：HUD 楼层切换 + 渲染指标 + 数据面板 -->
    <template #stage>
      <div class="hud">
        <div class="floor-btns">
          <button
            v-for="(f, i) in floors"
            :key="i"
            class="floor-btn"
            :class="{ active: currentFloor === i }"
            @click="switchFloor(i)"
          >
            {{ f }}
          </button>
        </div>
        <div class="metrics">drawcall {{ metrics.calls }} · 三角形 {{ metrics.tris }}</div>
      </div>

      <div v-if="panel.visible" class="panel">
        <div class="panel-head">
          <span class="dev-id">{{ panel.device.id }}</span>
          <span class="dev-status" :class="'s' + panel.device.status">{{ statusText(panel.device.status) }}</span>
        </div>
        <div class="row" v-for="r in rows" :key="r.key">
          <span class="label">{{ r.label }}</span>
          <span class="value">{{ panel.device[r.key] }}{{ r.unit }}</span>
        </div>
        <div class="updated">更新于 {{ panel.updatedAt }} · 1s 轮询</div>
      </div>
      <div v-else class="empty-tip">点击设备查看数据 · 双击相机聚焦</div>
    </template>
  </ThreeLayout>
</template>

<script setup>
/**
 * UI 层：只做 Vue 的事 —— 楼层按钮、数据面板、轮询定时器、渲染指标展示。
 * 页面骨架（stage/txt 收起展开）由 ThreeLayout 提供，本组件通过
 * layoutRef.stageRef 拿到 canvas 容器喂给场景模块。
 * three.js 场景的一切（InstancedMesh / 拾取 / 相机 / 呼吸动画 / dispose）
 * 在 DTwinScene.js，两者只通过 createWorkshopScene 的返回接口 + hooks 通信：
 *   UI → 场景：switchFloor / pollSelected / dispose
 *   场景 → UI：hooks.onSelect / onDeselect / onMetrics
 */
import { onMounted, onUnmounted, ref } from 'vue';
import ThreeLayout from '../components/ThreeLayout.vue';
import { createWorkshopScene } from './dtwin/DTwinScene';

const STATUS_TEXT = ['运行中', '告警', '停机'];
const rows = [
  { key: 'temp', label: '温度', unit: ' °C' },
  { key: 'rpm', label: '转速', unit: ' rpm' },
  { key: 'vib', label: '振动', unit: ' mm/s' },
  { key: 'out', label: '日产量', unit: ' 件' },
];

/* ===================== Vue 侧状态 =====================
 * 只有「面板需要的原始字段」（primitive）进 ref；
 * three 对象与 TypedArray 都在 scene 模块里，绝不进响应式系统。
 */
const floors = ['1F', '2F', '3F'];
const currentFloor = ref(0);
const metrics = ref({ calls: 0, tris: 0 });
const panel = ref({
  visible: false,
  updatedAt: '',
  device: { id: '', status: 0, temp: 0, rpm: 0, vib: 0, out: 0 },
});

const layoutRef = ref(null);

function statusText(s) {
  return STATUS_TEXT[s] ?? '未知';
}

/* ===================== 场景实例与 hooks 接线 ===================== */
let workshop = null;

// 场景 → UI：选中设备，把快照填进面板
function handleSelect(snap) {
  panel.value.device = snap;
  panel.value.updatedAt = new Date().toLocaleTimeString();
  panel.value.visible = true;
}

// 场景 → UI：取消选中，收起面板
function handleDeselect() {
  panel.value.visible = false;
}

// 场景 → UI：渲染指标（500ms 一次）
function handleMetrics(calls, tris) {
  metrics.value.calls = calls;
  metrics.value.tris = tris;
}

/* ===================== UI → 场景 ===================== */
function switchFloor(i) {
  if (!workshop) return;
  currentFloor.value = i;
  workshop.switchFloor(i);
}

// ThreeLayout 的舞台尺寸变化（txt 收起/展开）转发给场景自适应
function onStageResize() {
  workshop?.onStageResize();
}

/* ===================== 生命周期 ===================== */
onMounted(() => {
  // 场景创建失败静默（容器不存在等），面板/HUD 依然可渲染
  workshop = createWorkshopScene(layoutRef.value.stageRef, {
    onSelect: handleSelect,
    onDeselect: handleDeselect,
    onMetrics: handleMetrics,
  });

  // UI 层定时器：每秒向场景要一次选中设备快照（模拟 mock WebSocket 推送）
  dataTimer = setInterval(() => {
    const snap = workshop?.pollSelected();
    if (snap) handleSelect(snap);
  }, 1000);
});

/* 关键点：dispose 体系（UI 侧部分）
 * 定时器清掉 + 场景模块自身的 dispose（rAF/监听/GPU 资源/DOM）。
 * HMR 与路由来回切都不残留。
 */
let dataTimer = null;

function dispose() {
  if (dataTimer) clearInterval(dataTimer);
  dataTimer = null;
  panel.value.visible = false;
  workshop?.dispose();
  workshop = null;
}

onUnmounted(dispose);
</script>

<style scoped>
/* ---- HUD：楼层切换 + 渲染指标 ---- */
.hud {
  position: absolute;
  top: 10px;
  left: 10px;
  right: 10px;
  z-index: 20;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  pointer-events: none; /* 整层放行，只有按钮自己接事件 */
}

.floor-btns {
  display: flex;
  gap: 8px;
  pointer-events: auto;
}

.floor-btn {
  padding: 2px 10px;
  font-size: 11px;
  color: #333;
  background: rgba(255, 255, 255, 0.9);
  border: 2px solid #333;
  border-radius: 4px;
  cursor: pointer;
}

.floor-btn.active {
  background: var(--color-primary);
}

.metrics {
  padding: 2px 7px;
  font-size: 10px;
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
  border-radius: 4px;
}

/* ---- 右侧数据面板 ---- */
.panel {
  position: absolute;
  top: 46px;
  right: 10px;
  z-index: 20;
  width: 220px;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.96);
  border: 2px solid #333;
  border-radius: 6px;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 4px;
  margin-bottom: 4px;
  border-bottom: 1px solid #e5e0d5;
}

.dev-id {
  font-size: 13px;
  font-weight: bold;
  color: #222;
}

.dev-status {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  color: #fff;
}

.dev-status.s0 {
  background: #2e9e5b;
}

.dev-status.s1 {
  background: #e2483d;
}

.dev-status.s2 {
  background: #8a8f98;
}

.row {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  line-height: 2;
}

.label {
  color: #8a7f66;
}

.value {
  color: #222;
}

.updated {
  margin-top: 4px;
  font-size: 9px;
  color: #b0a893;
}

.empty-tip {
  position: absolute;
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  padding: 3px 10px;
  font-size: 10px;
  color: #fff;
  background: rgba(0, 0, 0, 0.5);
  border-radius: 4px;
  white-space: nowrap;
  pointer-events: none;
}
</style>
