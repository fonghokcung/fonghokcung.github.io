<template>
  <ThreeLayout ref="layoutRef" @stage-resize="onResize">
    <template #default>
      <h2 class="txt-title">《光阴的歌》（东山少爷）</h2>
      <!-- 歌词面板：直接复用 LINES（与画布同一数据源），溢出出竖向滚动条 -->
      <div class="txt-scroll">
        <p class="txt-sub">
          <span
            v-for="(line, i) in LINES"
            :key="i"
            class="txt-line"
            :class="{ 'txt-gap': line.gapBefore && i > 0 }"
            >{{ line.text }}</span
          >
        </p>
      </div>
    </template>

    <template #stage>
      <canvas ref="canvasRef" class="lyric-canvas"></canvas>
    </template>
  </ThreeLayout>
</template>

<script setup>
/* 歌词滚动 + 化沙退出动画（纯 2D Canvas）
 * 流程：每句停留 LINE_TIME 秒 → 旧句化沙随风散尽 → 整列滚动到下一句，循环往复
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import ThreeLayout from '@/components/ThreeLayout.vue';
import LINES from '@/assets/lyrics-guangyin.js'; // 歌词数据（展平行列表）

const layoutRef = ref(null);
const canvasRef = ref(null);

/* ===================== 排版 / 节奏参数 ===================== */
const LINE_H = 72; // 行距（px）
const STANZA_GAP = 48; // 段落额外间隙（px）
const BASE_FS = 44; // 统一字号（px）
const LINE_TIME = 3.4; // 每句停留（秒）
const LAST_HOLD = 4.6; // 末句停留（秒），结束后循环
const EXIT_T = 4; // 化沙动画总时长（秒）
const FONT = '"LXGW WenKai", "Noto Sans SC", "Microsoft YaHei", sans-serif'; // 霞鹜文楷优先
const FONT_WEIGHT = 700; // 文楷最粗为 Bold（900 会被浏览器仿粗合成）
const COLOR_BASE = '#ffffff'; // 当前句：白色
const COLOR_DIM = '#42b883'; // 其余句

/* ===================== 运行时状态 ===================== */
let canvasEl = null;
let ctx = null;
let dpr = 1; // 渲染分辨率比（onResize 时更新，图层坐标换算用）
let rafId = 0;
let disposed = false;
let viewW = 0;
let viewH = 0;

let current = 0; // 当前句下标
let lineTime = 0; // 当前句已停留时间（秒）
let scrollCur = 0; // 平滑滚动位置（px）
let lastTime = 0;

// 化沙退出状态：旧句字形采样成沙粒
// 原句本体始终整句显示，风化过程只通过飞沙粒子表现
let exitState = null;
let exitLine = -1; // 正在化沙的句子下标，-1 表示无
{
  const PX = 4; // 采样步长（px），字号翻倍后相应放大，控制出生点总量
  const COPIES = 4; // 每个出生点克隆成几粒沙（直接控制粒子总量倍数）
  exitState = {
    PX,
    COPIES,
    sx: null, // 沙粒出生点 X（相对主句中心）
    sy: null, // 沙粒出生点 Y
    vx: null, // 水平初速
    vy: null, // 垂直初速
    delay: null, // 起风延迟（秒）：行尾先飞
    n: 0, // 沙粒数量
    t: 0, // 化沙已进行时间（秒）
    halfW: 1, // 字形半宽（px），行首/行尾归一化用
  };
}

// 离屏渲染文字并按网格采样 alpha 通道，得到沙粒出生点（相对文字中心）
function sampleTextPoints(text, fs) {
  const off = document.createElement('canvas');
  const octx = off.getContext('2d', { willReadFrequently: true });
  octx.font = `${FONT_WEIGHT} ${fs}px ${FONT}`;
  const tw = Math.ceil(octx.measureText(text).width) + 8;
  const th = Math.ceil(fs * 1.5);
  off.width = tw;
  off.height = th;
  const c2 = off.getContext('2d');
  c2.font = `${FONT_WEIGHT} ${fs}px ${FONT}`;
  c2.fillStyle = '#fff';
  c2.textBaseline = 'middle';
  c2.fillText(text, 4, th / 2);
  const img = c2.getImageData(0, 0, tw, th).data;
  const pts = [];
  for (let y = 0; y < th; y += exitState.PX) {
    for (let x = 0; x < tw; x += exitState.PX) {
      if (img[(y * tw + x) * 4 + 3] > 110) {
        // 网格点加 ±1px 亚像素抖动，打散规则点阵，视觉更接近真沙
        pts.push(
          x - tw / 2 + (Math.random() - 0.5) * 2,
          y - th / 2 + (Math.random() - 0.5) * 2,
        );
      }
    }
  }
  return { pts, w: tw };
}

// 开始化沙：当前句采样为沙粒（原句仍走普通绘制流程，无需快照）
function startExit() {
  const text = LINES[current].text;
  const { pts, w } = sampleTextPoints(text, BASE_FS);
  // 每个出生点克隆 COPIES 粒沙，粒子总量 = 出生点数 × COPIES
  const srcN = pts.length / 2;
  const n = srcN * exitState.COPIES;
  // 粒子池按需扩容
  if (exitState.n < n) {
    exitState.sx = new Float32Array(n);
    exitState.sy = new Float32Array(n);
    exitState.vx = new Float32Array(n);
    exitState.vy = new Float32Array(n);
    exitState.delay = new Float32Array(n);
  }
  exitState.n = n;
  exitState.t = 0;
  exitState.halfW = Math.max(w / 2, 1);
  exitLine = current;

  // 沙粒出生点 + 起风延迟 + 初速：行尾先飞，形成从右往左的撕开感；
  // 同一出生点的克隆粒共享延迟（同步起飞），初速略异（散开）
  for (let i = 0; i < n; i++) {
    const p = i % srcN;
    const sx = pts[p * 2];
    const sy = pts[p * 2 + 1];
    exitState.sx[i] = sx + (Math.random() - 0.5) * 2;
    exitState.sy[i] = sy + (Math.random() - 0.5) * 2;
    // 冲量式初速：方向随机但偏向上（上方概率占大头，正下方极少），
    // 只靠阻尼减速
    // 全部粒子同时起飞，仅保留极小随机抖动让爆发更自然
    exitState.delay[i] = Math.random() * 0.06;
    const speed = 100 + Math.random() * 120; // 爆发速度（上抛射程约一半）
    // 方向偏置：95% 上半圆均匀随机（向上占大头），5% 全圆纯随机
    const r = Math.random();
    const ang =
      r < 0.95
        ? -Math.random() * Math.PI // 上半圆：0°~180° 向上均匀
        : Math.random() * Math.PI * 2 - Math.PI; // 5% 纯随机方向
    exitState.vx[i] = Math.cos(ang) * speed;
    exitState.vy[i] = Math.sin(ang) * speed;
  }
}

// 每行的目标滚动偏移：前序行高与段落间隙的累计值
const offsets = [];
{
  let acc = 0;
  for (let i = 0; i < LINES.length; i++) {
    offsets.push(acc);
    acc += LINE_H + (LINES[i + 1]?.gapBefore ? STANZA_GAP : 0);
  }
}

/* ===================== 绘制 ===================== */
function draw() {
  ctx.clearRect(0, 0, viewW, viewH);
  const centerY = viewH / 2;
  const exiting = exitState.t < EXIT_T; // 化沙进行中
  ctx.font = `${FONT_WEIGHT} ${BASE_FS}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // 飞沙层先画：粒子始终垫在歌词后面，不遮挡文字
  if (exiting) {
    const er = exitState;
    ctx.save();
    ctx.translate(viewW / 2, centerY);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    for (let i = 0; i < er.n; i++) {
      const age = er.t - er.delay[i];
      if (age <= 0) continue;
      const x = er.sx[i];
      const y = er.sy[i];
      // 透明度分段：前 70% 寿命保持完全不透明（充分呈现），
      // 只在最后 30% 线性淡出，消失时间占比小
      const flyT = age / (EXIT_T - 1.4);
      const a = flyT >= 1 ? 0 : flyT < 0.7 ? 1 : 1 - (flyT - 0.7) / 0.3;
      if (a <= 0.02) continue;
      ctx.globalAlpha = a;
      const s = 2; // 粒子尺寸（px）
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
    }
    ctx.restore();
  }

  // 歌词行后画：主句黄色带光晕，其余绿色按离中心距离衰减透明度；
  // 化沙中的旧句保持黄色高亮（isWhite），新主句等化沙结束才点亮
  for (let i = 0; i < LINES.length; i++) {
    const y = offsets[i] - scrollCur + centerY;
    if (y < -LINE_H * 2 || y > viewH + LINE_H * 2) continue; // 视口外跳过
    const dy = Math.abs(y - centerY);
    const focus = Math.max(0, 1 - dy / (viewH * 0.42));
    const isWhite = i === exitLine || (exitLine < 0 && i === current);
    ctx.save();
    ctx.translate(viewW / 2, y);
    ctx.fillStyle = isWhite ? COLOR_BASE : COLOR_DIM;
    ctx.globalAlpha = 0.9;
    if (isWhite) {
      ctx.shadowColor = 'rgba(255, 255, 255, 0.55)'; // 与主句同色系的光晕
      ctx.shadowBlur = 18;
    }
    ctx.fillText(LINES[i].text, 0, 0);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

/* ===================== 物理推进 ===================== */
function updateExit(dt) {
  exitState.t += dt;
  const windT = exitState.t;
  for (let i = 0; i < exitState.n; i++) {
    const age = windT - exitState.delay[i];
    if (age <= 0) continue; // 未起风：钉在字位
    // 起飞后只受强阻尼：先冲出去（强烈加速感来自初速本身），
    // 速度指数衰减（约 0.5s 内降到 1/10），总位移 ≈ 初速/阻尼，被限制在主句附近
    const drag = 1 - Math.min(1, dt * 5);
    // 轻微湍流抖动，不产生净位移
    const turb =
      Math.sin(windT * 7 + exitState.sy[i] * 0.11 + i) * 30 +
      Math.sin(windT * 13 + exitState.sx[i] * 0.07) * 20;
    exitState.vx[i] = (exitState.vx[i] + turb * dt) * drag;
    exitState.vy[i] = (exitState.vy[i] + turb * dt) * drag;
    exitState.sx[i] += exitState.vx[i] * dt;
    exitState.sy[i] += exitState.vy[i] * dt;
  }
}

/* ===================== 推进 ===================== */
// 当前句开始化沙退出，并切到下一句（循环）
function advance() {
  lineTime = 0;
  startExit();
  current = current >= LINES.length - 1 ? 0 : current + 1;
}

function loop(now) {
  rafId = requestAnimationFrame(loop);
  if (disposed) return;
  const dt = Math.min((now - lastTime) / 1000, 0.05); // 钳制长帧，防后台切回爆发
  lastTime = now;

  if (exitLine >= 0) {
    // 化沙期间：只推沙粒物理，计时与滚动暂停
    if (exitState.t < EXIT_T) {
      updateExit(dt);
    } else {
      exitLine = -1; // 动画结束，恢复滚动
    }
  } else {
    lineTime += dt;
    const dur = current === LINES.length - 1 ? LAST_HOLD : LINE_TIME;
    // 滚动须先于 advance()：切句同帧若朝新句目标滚一步再被冻结，
    // 整列会瞬间上跳数像素（肉眼可见的晃动）
    scrollCur += (offsets[current] - scrollCur) * Math.min(1, dt * 6);
    if (lineTime >= dur) advance();
  }
  draw();
}

/* ===================== 尺寸自适应 ===================== */
function onResize() {
  if (!canvasEl || !ctx) return;
  const container = layoutRef.value?.stageRef;
  if (!container) return;
  const rect = container.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvasEl.width = rect.width * dpr;
  canvasEl.height = rect.height * dpr;
  canvasEl.style.width = rect.width + 'px';
  canvasEl.style.height = rect.height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  viewW = rect.width;
  viewH = rect.height;
}

// 点击舞台立即切换下一句
function onClickStage() {
  advance();
}

/* ===================== 生命周期 ===================== */
onMounted(() => {
  canvasEl = canvasRef.value;
  ctx = canvasEl.getContext('2d');
  canvasEl.addEventListener('click', onClickStage);
  onResize();
  lastTime = performance.now();
  // 显式触发霞鹜文楷加载再启动：canvas 经 JS 绘制不会自动触发 webfont 下载，
  // 仅靠 fonts.ready 可能在字体就绪前就 resolve，导致首句回退雅黑
  const kick = () => {
    rafId = requestAnimationFrame(loop);
  };
  const probe = `${FONT_WEIGHT} 22px "LXGW WenKai"`;
  if (document.fonts?.load) {
    document.fonts
      .load(probe, '光阴的歌')
      .catch(() => {})
      .then(() => kick());
  } else {
    kick();
  }
});

onBeforeUnmount(() => {
  disposed = true;
  cancelAnimationFrame(rafId);
  canvasEl?.removeEventListener('click', onClickStage);
});
</script>

<style scoped>
.txt-scroll {
  /* 限高触发滚动：减去面板上下 padding 与标题行高度（面板总高 100vh） */
  max-height: calc(100vh - 70px);
  overflow-y: auto;
  padding-right: 6px; /* 滚动条与文字留些距离 */
}
.txt-line {
  display: block;
}
.txt-gap {
  margin-top: 24px; /* 段落间隙（与画布 STANZA_GAP 视觉对齐） */
}
.lyric-canvas {
  display: block;
  width: 100%;
  height: 100%;
  background: #0d1b2a;
  cursor: pointer;
}
</style>
