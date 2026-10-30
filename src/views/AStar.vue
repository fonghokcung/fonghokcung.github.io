<template>
  <ThreeLayout class="AStar__vue" ref="layoutRef" @stage-resize="onResize">
    <template #default>
      <h1 class="txt-title">A* 搜寻算法</h1>
      <p class="txt-sub">
        <a
          class="as-link"
          href="https://en.wikipedia.org/wiki/A*_search_algorithm"
          target="_blank"
          rel="noopener noreferrer"
          >A*（A-Star）算法</a
        >
        是静态路网中求解最短路径最有效的直接搜索方法。公式 f(n) = g(n) + h(n)：
      </p>
      <p class="txt-sub">
        g(n) 是从初始状态到状态 n 的实际代价，h(n) 是从状态 n
        到目标状态的估计代价（启发函数），f(n) 是经由 n
        到终点的代价估计。距离估算值与实际值越接近，搜索越快。
      </p>
      <p class="txt-hint">
        <span>起点（左下）→ 终点（右上）；</span>
        <span>蓝=开放集（正在处理）</span>
        <span>黄=A* 已定案区域</span>
        <span>黄粗线=A* 实时最短路链</span>
        <span>白=BFS对照搜索的撒网范围</span>
        <span>白粗线=BFS 实时探测链（重叠处显示 A* 颜色）</span>
      </p>
    </template>

    <template #stage>
      <canvas ref="canvasRef" class="astar-canvas"></canvas>
      <div
        class="panel overlay-corner"
        :class="{ locked: running, hidden: running && isMobile }"
      >
        <label class="row">
          <span class="name">疏密</span>
          <input
            type="range"
            min="0.02"
            max="1"
            step="0.02"
            v-model.number="rate"
            :disabled="running"
          />
          <span class="val">{{ rateLabel }}</span>
        </label>
        <label class="row">
          <span class="name">网格</span>
          <input
            type="range"
            min="10"
            max="40"
            step="2"
            v-model.number="gridSize"
            :disabled="running"
          />
          <span class="val">{{ gridSize }}px</span>
        </label>
        <label class="row row-switch">
          <span class="name">L障碍</span>
          <input
            id="wall-switch"
            v-model="wantWall"
            type="checkbox"
            class="switch-input"
            :disabled="running"
          />
          <label
            for="wall-switch"
            class="switch"
            :class="{ on: wantWall, disabled: running }"
          >
            <i class="knob"></i>
          </label>
        </label>
        <label class="row row-switch">
          <span class="name">等待BFS</span>
          <input
            id="waitbfs-switch"
            v-model="waitBfs"
            type="checkbox"
            class="switch-input"
            :disabled="running"
          />
          <label
            for="waitbfs-switch"
            class="switch"
            :class="{ on: waitBfs, disabled: running }"
          >
            <i class="knob"></i>
          </label>
        </label>
        <div class="btn-row">
          <button class="start-btn" :disabled="running" @click="buildNetwork">
            生成路网
          </button>
          <button
            class="start-btn secondary"
            :disabled="running || searched"
            @click="searchPath"
          >
            寻找最短路径
          </button>
        </div>
      </div>
    </template>
  </ThreeLayout>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import ThreeLayout from '@/components/ThreeLayout.vue';
import { Astar } from '@/views/astar/astar-core';

const layoutRef = ref(null);
const canvasRef = ref(null);

const rate = ref(0.3); // 无向边存在率 0.02~1（布网前注入，决定路网结构）
const gridSize = ref(20); // 网格单位长度 px（布网前注入）
const wantWall = ref(false); // L 形隔墙（布网前注入）
const waitBfs = ref(false); // A* 到终点后是否等 BFS（寻路前注入，只影响搜寻）
const running = ref(false); // 搜寻进行中：锁定面板
const searched = ref(false); // 本局已寻过路：次按钮置灰（寻路一次即定格）
const isMobile = window.innerWidth < 768; // 移动端：搜寻中面板整体隐藏

const rateLabel = computed(() =>
  rate.value >= 1 ? '全连通' : rate.value.toFixed(2),
);

let canvasEl = null;
let rafId = 0;
let disposed = false;
let astar = null;

function loop() {
  rafId = requestAnimationFrame(loop);
  if (disposed || !astar) return;
  astar.step();
}

// 布网前参数注入：rate/gridSize/wantWall 决定路网结构，必须先于 resize
function applyParams() {
  astar.rate = rate.value;
  astar.gridSize = gridSize.value;
  astar.wantWall = wantWall.value;
  astar.waitBfs = waitBfs.value;
}

// 阶段一「生成路网」：按面板参数重建路网，画面停在「路网就绪」，
// 不自动搜寻——用户可先观察路网（L 障碍位置、走廊形态）再动手。
// 布网是同步的：resize→init 即完成，立即解锁（onComplete 是搜寻
// 完成专用回调，布网不触发）；移动端面板搜寻中才隐藏，就绪态保持显示
function buildNetwork() {
  if (!astar || running.value) return;
  searched.value = false; // 新局：恢复「寻找最短路径」可点
  running.value = true;
  applyParams();
  const container = layoutRef.value?.stageRef;
  if (container) {
    const rect = container.getBoundingClientRect();
    astar.resize(
      Math.round(rect.width),
      Math.round(rect.height),
      window.innerWidth < 768,
    );
  }
  running.value = false;
}

// 阶段二「寻找最短路径」：在当前路网上初始化搜寻状态并逐帧推进。
// 一局只寻一次：完成后按钮置灰，画面定格展示结果；点「生成路网」
// 开新局后按钮恢复可点。
// waitBfs 必须在此刻同步：它只影响搜寻行为、不影响布网，允许在
// 「生成路网之后、寻路之前」翻转开关——参数若只在布网时注入，
// 就绪态翻转会被静默吞掉（实例字段停在旧值）
function searchPath() {
  if (!astar || running.value || !astar.ready) return;
  searched.value = true;
  running.value = true;
  astar.waitBfs = waitBfs.value;
  astar.startSearch();
}

function onResize() {
  if (!canvasEl || disposed) return;
  const container = layoutRef.value?.stageRef;
  if (!container) return;
  const rect = container.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  // 窗口变化只适配画布尺寸（保持当前局，路网密度/行列数不随窗口突变）；
  // 布网始终由「生成路网」按钮触发
  if (!astar) return;
  astar.stageW = Math.round(rect.width);
  astar.stageH = Math.round(rect.height);
  astar.eleCanvas.width = astar.stageW * astar.dpr;
  astar.eleCanvas.height = astar.stageH * astar.dpr;
  astar.ctx.setTransform(astar.dpr, 0, 0, astar.dpr, 0, 0);
}

onMounted(() => {
  canvasEl = canvasRef.value;
  astar = new Astar(canvasEl);
  astar.onComplete = () => {
    running.value = false;
  };
  loop();
  // 进页面自动跑完整一轮：生成路网 + 寻找最短路径（默认参数：0.3 / 20px / 无墙）
  buildNetwork();
  searchPath();
});

onBeforeUnmount(() => {
  disposed = true;
  cancelAnimationFrame(rafId);
});
</script>

<style scoped>
.astar-canvas {
  display: block;
  width: 100%;
  height: 100%;
  background: #141414;
}
.as-link {
  color: var(--color2);
  text-decoration: none;
  border-bottom: 1px dashed currentcolor;
}
.as-link:hover {
  text-decoration: underline;
}
.panel {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 190px;
  padding: 11px 13px;
  background: rgba(13, 27, 42, 0.78);
  border: 1px solid rgba(230, 237, 243, 0.25);
  border-radius: 8px;
  backdrop-filter: blur(4px);
  /* 移动优先：預設水平垂直居中（覆盖全局 .overlay-corner 的 top/right 锚点） */
  top: 50%;
  right: auto;
  left: 50%;
  transform: translate(-50%, -50%);
}
/* 桌面端（≥768px）：切左上角（避开的是移动端汉堡按钮，桌面无此顾虑） */
@media (min-width: 768px) {
  .panel.overlay-corner {
    top: 14px;
    left: 14px;
    transform: none;
  }
}
/* 移动端搜寻中：面板整体淡出（不遮挡小屏幕上的寻路画面），完成后复位显示 */
.panel.hidden {
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: #e6edf3;
}
.row .name {
  width: 56px;
  text-align: right;
}
.row .val {
  width: 42px;
  font-variant-numeric: tabular-nums;
  color: #7ee787;
}
.row input[type='range'] {
  flex: 1;
  accent-color: var(--color2);
}
/* accent-color 会盖掉原生 disabled 灰化，禁用时显式切回灰 */
.row input[type='range']:disabled {
  opacity: 0.4;
}
/* 纯 CSS switch：隐藏原生 checkbox，轨道 + 圆钮随勾选态滑动变色 */
.switch-input {
  display: none;
}
.switch {
  position: relative;
  width: 34px;
  height: 18px;
  cursor: pointer;
  background: rgba(230, 237, 243, 0.18);
  border-radius: 9px;
  transition: background 0.15s;
}
.switch .knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  background: #e6edf3;
  border-radius: 50%;
  transition: transform 0.15s;
}
.switch.on {
  background: var(--color2);
}
.switch.on .knob {
  transform: translateX(16px);
}
/* 搜寻中锁定：switch 视觉灰化且不可点 */
.switch.disabled {
  cursor: not-allowed;
  opacity: 0.4;
  pointer-events: none;
  background: white;
}
/* 搜寻中面板整体降透明（输入控件已逐个 disabled，这里再压文字对比度）；
   整个面板 cursor: not-allowed，滑杆/文字上悬停同样提示不可用 */
.panel.locked {
  cursor: not-allowed;
}
.panel.locked .name,
.panel.locked .val {
  opacity: 0.45;
}
.panel.locked input[type='range'],
.panel.locked .start-btn {
  cursor: not-allowed;
}
/* 双按钮行：生成路网（主）/ 寻找最短路径（次） */
.btn-row {
  display: flex;
  gap: 7px;
  margin-top: 3px;
}
.btn-row .start-btn {
  flex: 1;
  margin-top: 0;
}
.start-btn {
  padding: 7px 0;
  font-size: 13px;
  font-weight: bold;
  color: #0d1b2a;
  cursor: pointer;
  background: #7ee787;
  border: none;
  border-radius: 5px;
}
/* 次按钮（寻找最短路径）：降一档视觉强度 */
.start-btn.secondary {
  color: #7ee787;
  background: rgba(126, 231, 135, 0.12);
  border: 1px solid rgba(126, 231, 135, 0.55);
}
.start-btn:hover:not(:disabled) {
  filter: brightness(1.1);
}
.start-btn:disabled {
  color: #41586b;
  background: rgba(126, 231, 135, 0.25);
  cursor: not-allowed;
}
.start-btn.secondary:disabled {
  background: rgba(126, 231, 135, 0.08);
  border-color: rgba(126, 231, 135, 0.2);
}
.txt-hint span {
  display: block;
}
</style>
