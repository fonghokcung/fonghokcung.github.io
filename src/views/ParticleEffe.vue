<template>
  <ThreeLayout
    v-loading="fontLoading"
    class="ParticleEffe__vue"
    ref="layoutRef"
    @stage-resize="onResize"
  >
    <template #default>
      <h1 class="txt-title">《光阴的歌》（东山少爷）</h1>
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
      <!-- 顶部播放进度条：宽度由 rAF 每帧直接写 DOM（不触发组件重渲染） -->
      <div class="lyric-progress">
        <i ref="barRef" class="lyric-progress-bar"></i>
      </div>
    </template>
  </ThreeLayout>
</template>

<script setup>
/* 歌词滚动 + 化沙退出动画（纯 2D Canvas）
 * 流程：每句停留 LINE_TIME 秒 → 旧句化沙随风散尽 → 整列滚动到下一句，循环往复
 * 背景层：极慢飘雪（垫在歌词与飞沙之下，只做氛围）
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import ThreeLayout from '@/components/ThreeLayout.vue';
import LINES from '@/assets/lyrics-guangyin.js'; // 歌词数据（展平行列表）

const layoutRef = ref(null);
const canvasRef = ref(null);
const barRef = ref(null); // 顶部进度条填充元素
/* 字体未就绪时盖加载遮罩：避免首句以回退雅黑渲染后突然跳成文楷 */
const fontLoading = ref(true);

/* ===================== 排版 / 节奏参数 =====================
 * 字号/行距按「桌面舞台宽度」定的设计基准，运行时由 fitText() 按舞台实际宽度
 * 等比缩放——移动端一屏能完整放下一行歌词（最长句也不溢出） */
const DESIGN_FS = 44; // 基准字号（px）
const DESIGN_LINE_H = 72; // 基准行距（px）
const DESIGN_STANZA_GAP = 48; // 基准段落额外间隙（px）
const LINE_TIME = 3.4; // 每句停留（秒）
const LAST_HOLD = 4.6; // 末句停留（秒），结束后循环
const EXIT_T = 4; // 化沙动画总时长（秒）
const FONT = '"LXGW WenKai", "Noto Sans SC", "Microsoft YaHei", sans-serif'; // 霞鹜文楷优先
const FONT_WEIGHT = 700; // 文楷最粗为 Bold（900 会被浏览器仿粗合成）
const COLOR_BASE = '#ffffff'; // 当前句：白色
const COLOR_DIM = '#42b883'; // 其余句

/* 运行时排版量（fitText 依舞台宽度更新；offsets 随字号重算） */
let fontSize = DESIGN_FS;
let lineH = DESIGN_LINE_H;
let stanzaGap = DESIGN_STANZA_GAP;
let offsets = [];

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
let snowT = 0; // 飘雪累计时间（秒），摆动相位用

/* ===================== 背景飘雪 ===================== */
// 参考 three.js 官方 webgpu_compute_particles_snow：固定锚点 + 双正弦超低频长弧摆动
// + 极慢下落 + 大量软边小粒子。x/z 两轴摆动各映射到屏幕横向，合成不规则长弧漂移
let snow = [];
let snowSprite = null; // 预渲染软圆雪粒（径向渐变），比硬边圆柔和得多

function makeSnowSprite() {
  const s = document.createElement('canvas');
  s.width = s.height = 32;
  const c = s.getContext('2d');
  const g = c.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, 32, 32);
  snowSprite = s;
}

// 生成一片雪：所有量随 r（远近）联动，大片=近=快=实
function newFlake(anywhere) {
  const r = 0.6 + Math.random() * 2.4; // 半径 0.6~3.0px
  return {
    x0: Math.random() * viewW, // 摆动锚点（参考例存初始 x/z 的思路）
    y: anywhere ? Math.random() * viewH : -8,
    r,
    vy: (7 + Math.random() * 15) * (0.5 + ((r - 0.6) / 2.4) * 0.9), // 下落 4~30px/s
    // 双正弦长弧：参考例 x=sin(t·r²·s)·3、z=cos(t·r·s)·10r——频率互质、
    // 周期 15s 起步，相位随机，轨迹是不闭合的利萨茹长弧，永不折返
    a1: 7 + Math.random() * 15, // 主摆幅
    w1: 0.05 + Math.random() * 0.3, // 主角频率 rad/s（周期 21~125s）
    a2: 5 + Math.random() * 25, // 副摆幅（可很大，负责慢漂移）
    w2: 0.08 + Math.random() * 0.32, // 副角频率
    p1: Math.random() * Math.PI * 2,
    p2: Math.random() * Math.PI * 2,
    a: 0.3 + ((r - 0.6) / 2.4) * 0.55 + Math.random() * 0.05, // 近实远淡
  };
}

function initSnow() {
  makeSnowSprite();
  const n = Math.min(420, Math.round((viewW * viewH) / 2800)); // 大幅加密度，雪才像雪
  snow = [];
  for (let i = 0; i < n; i++) snow.push(newFlake(true));
}

function updateSnow(dt) {
  snowT += dt;
  for (const f of snow) {
    f.y += f.vy * dt;
    // 位置式双正弦：绕锚点的长弧摆动（参考例同款结构）
    f.x =
      f.x0 +
      Math.sin(snowT * f.w1 + f.p1) * f.a1 +
      Math.sin(snowT * f.w2 + f.p2) * f.a2;
    // 落出底部：回顶部、锚点重随机
    if (f.y - f.r > viewH) {
      f.y = -8;
      f.x0 = Math.random() * viewW;
    }
    // 长弧把 x 甩出边界时对锚点环形回绕
    const m = f.a1 + f.a2 + f.r * 4;
    if (f.x < -m) f.x0 += viewW + m * 2;
    else if (f.x > viewW + m) f.x0 -= viewW + m * 2;
  }
}

function drawSnow() {
  for (const f of snow) {
    ctx.globalAlpha = f.a;
    const s = f.r * 2.5; // 贴图含柔和光晕，绘制尺寸略大于逻辑半径
    ctx.drawImage(snowSprite, f.x - s / 2, f.y - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
}

// 化沙退出状态：旧句字形采样成沙粒
// 原句本体始终整句显示，风化过程只通过飞沙粒子表现
let exitState = null;
let exitLine = -1; // 正在化沙的句子下标，-1 表示无
{
  const PX = 2; // 采样密度（px）：撒点越密总量越大，配合无克隆控制粒子数
  const COPIES = 1; // 不再克隆：同一位置多粒编队飞行会产生规则感
  exitState = {
    PX,
    COPIES,
    sx: null, // 沙粒出生点 X（相对主句中心）
    sy: null, // 沙粒出生点 Y
    vx: null, // 水平初速
    vy: null, // 垂直初速
    delay: null, // 起风延迟（秒）：行尾先飞
    rs: null, // 沙粒尺寸（px），粒粒随机
    ra: null, // 沙粒基础透明度，粒粒随机
    n: 0, // 沙粒数量
    t: 0, // 化沙已进行时间（秒）
    halfW: 1, // 字形半宽（px），行首/行尾归一化用
  };
}

// 离屏渲染文字后两级随机采样：
// ① 拒绝采样——包围盒随机撒点，命中笔画才收（位置真随机）
// ② blob 疏密场——32px 粗格随机 + 3×3 盒滤波 + 对比度拉满（0.03~1），
//    密度成大片贫富区（平滑 blob 而非椒盐碎点），根治「处处一样密」
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
  // blob 疏密场：粗格随机 → 盒滤波平滑 → 归一化拉开对比
  const CELL = 32;
  const cols = Math.ceil(tw / CELL) + 2;
  const rows = Math.ceil(th / CELL) + 2;
  const raw = new Float32Array(cols * rows);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.random();
  const density = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = Math.min(rows - 1, Math.max(0, r + dr));
        for (let dc = -1; dc <= 1; dc++) {
          const cc = Math.min(cols - 1, Math.max(0, c + dc));
          sum += raw[rr * cols + cc];
        }
      }
      density[r * cols + c] = sum / 9;
    }
  }
  let dMin = Infinity;
  let dMax = -Infinity;
  for (let i = 0; i < density.length; i++) {
    if (density[i] < dMin) dMin = density[i];
    if (density[i] > dMax) dMax = density[i];
  }
  const span = Math.max(1e-6, dMax - dMin);
  for (let i = 0; i < density.length; i++)
    density[i] = 0.03 + ((density[i] - dMin) / span) * 0.97;

  const pts = [];
  const attempts = Math.round((tw * th) / (exitState.PX * exitState.PX));
  for (let i = 0; i < attempts; i++) {
    const x = Math.random() * tw;
    const y = Math.random() * th;
    const d = density[((y / CELL) | 0) * cols + ((x / CELL) | 0)];
    if (Math.random() > d) continue; // 疏密调制：按所在 blob 密度决定去留
    if (img[((y | 0) * tw + (x | 0)) * 4 + 3] > 110) {
      pts.push(x - tw / 2, y - th / 2);
    }
  }
  return { pts, w: tw };
}

// 开始化沙：当前句采样为沙粒（原句仍走普通绘制流程，无需快照）
function startExit() {
  const text = LINES[current].text;
  const { pts, w } = sampleTextPoints(text, fontSize);
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
    exitState.rs = new Float32Array(n);
    exitState.ra = new Float32Array(n);
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
    // 冲量式初速 + 右上风向：初速 = 全向爆发（100~220）+ 恒定右上风漂移（+70, -55），
    // 屏幕坐标 y 向下，vy 负值即向上——叠加后整体朝右上飞散
    exitState.delay[i] = Math.random() * 0.06;
    const speed = 100 + Math.random() * 120; // 爆发速度（上抛射程约一半）
    // 方向偏置：95% 上半圆均匀随机（向上占大头），5% 全圆纯随机
    const r = Math.random();
    const ang =
      r < 0.95
        ? -Math.random() * Math.PI // 上半圆：0°~180° 向上均匀
        : Math.random() * Math.PI * 2 - Math.PI; // 5% 纯随机方向
    exitState.vx[i] = Math.cos(ang) * speed + 80; // +x 向右风（比上浮更强）
    exitState.vy[i] = Math.sin(ang) * speed + 20; // -y 向上风（压低飞高）
    // 粒粒独立的尺寸与透明度：平方分布偏小粒，避免「粒粒一样大」的均匀感
    exitState.rs[i] = 1 + Math.random() * Math.random() * 2.4;
    exitState.ra[i] = 0.3 + Math.random() * 0.7;
  }
}

// 每行的目标滚动偏移：前序行高与段落间隙的累计值（字号变化时重算）
function rebuildOffsets() {
  offsets = [];
  let acc = 0;
  for (let i = 0; i < LINES.length; i++) {
    offsets.push(acc);
    acc += lineH + (LINES[i + 1]?.gapBefore ? stanzaGap : 0);
  }
}
rebuildOffsets();

/* ===================== 绘制 ===================== */
function draw() {
  ctx.clearRect(0, 0, viewW, viewH);
  const centerY = viewH / 2;
  const exiting = exitState.t < EXIT_T; // 化沙进行中
  ctx.font = `${FONT_WEIGHT} ${fontSize}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // 飘雪垫底：最先画，位于飞沙与歌词之下
  drawSnow();

  // 飞沙层先画：粒子始终垫在歌词后面，不遮挡文字
  if (exiting) {
    const er = exitState;
    ctx.save();
    ctx.translate(viewW / 2, centerY);
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < er.n; i++) {
      const age = er.t - er.delay[i];
      if (age <= 0) continue;
      const x = er.sx[i];
      const y = er.sy[i];
      // 透明度分段：前 70% 寿命保持固有透明度（充分呈现），
      // 只在最后 30% 线性淡出，消失时间占比小
      const flyT = age / (EXIT_T - 1.4);
      const fade = flyT >= 1 ? 0 : flyT < 0.7 ? 1 : 1 - (flyT - 0.7) / 0.3;
      const a = fade * er.ra[i]; // 固有透明度 × 寿命淡出
      if (a <= 0.02) continue;
      ctx.globalAlpha = a;
      const s = er.rs[i]; // 粒粒独立尺寸
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
    }
    ctx.restore();
  }

  // 歌词行后画：主句黄色带光晕，其余绿色按离中心距离衰减透明度；
  // 化沙中的旧句保持黄色高亮（isWhite），新主句等化沙结束才点亮
  for (let i = 0; i < LINES.length; i++) {
    const y = offsets[i] - scrollCur + centerY;
    if (y < -lineH * 2 || y > viewH + lineH * 2) continue; // 视口外跳过
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

// 进度条：整首播放位置 = （已过句数 + 当前句内已停留比例）/ 总句数。
// 化沙期间 current 已切到下一句、计时冻结，用 exitLine + 1 保持停在该句上
function updateProgressBar() {
  if (!barRef.value) return;
  const dur = current === LINES.length - 1 ? LAST_HOLD : LINE_TIME;
  const pos =
    exitLine >= 0 ? exitLine + 1 : current + Math.min(1, lineTime / dur);
  barRef.value.style.width = `${((pos / LINES.length) * 100).toFixed(2)}%`;
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
  updateSnow(dt); // 飘雪不受化沙影响，一直下
  updateProgressBar();
  draw();
}

/* ===================== 尺寸自适应 ===================== */
/* 字号自适应：按最长一句的实测宽度反推字号（上限为设计基准），
 * 行距/段落间隙同比缩放并重算滚动偏移。
 * 移动端舞台窄 → 字号自动变小，一屏能完整放下一句歌词 */
function fitText() {
  ctx.font = `${FONT_WEIGHT} ${DESIGN_FS}px ${FONT}`;
  let maxW = 0;
  for (const line of LINES) {
    const w = ctx.measureText(line.text).width;
    if (w > maxW) maxW = w;
  }
  const scale = Math.min(1, (viewW * 0.9) / Math.max(maxW, 1));
  fontSize = Math.max(16, Math.round(DESIGN_FS * scale));
  const k = fontSize / DESIGN_FS;
  lineH = Math.round(DESIGN_LINE_H * k);
  stanzaGap = Math.round(DESIGN_STANZA_GAP * k);
  rebuildOffsets();
}

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
  fitText(); // 字体可用性/舞台宽度变化都需重新拟合字号
  if (!snow.length) initSnow(); // 首次拿到尺寸时生成雪片；后续仅随视口自然回收
}

/* ===================== 生命周期 ===================== */
// 霞鹜文楷 webfont 的 CSS 仅本页使用：组件挂载时动态注入 <link>，
// 卸载时移除——避免全站（index.html）为单个页面阻塞首屏加载
const FONT_CSS_URL =
  'https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/style.css';
let fontLinkEl = null; // 动态注入的 <link>，卸载时移除

function loadFontCss() {
  fontLinkEl = document.createElement('link');
  fontLinkEl.rel = 'stylesheet';
  fontLinkEl.href = FONT_CSS_URL;
  document.head.appendChild(fontLinkEl);
}

onMounted(() => {
  loadFontCss();
  canvasEl = canvasRef.value;
  ctx = canvasEl.getContext('2d');
  onResize();
  lastTime = performance.now();
  // 显式触发霞鹜文楷加载再启动：canvas 经 JS 绘制不会自动触发 webfont 下载，
  // 仅靠 fonts.ready 可能在字体就绪前就 resolve，导致首句回退雅黑
  // 遮罩至少展示 1s：字体缓存秒开时转圈一闪而过反而刺眼
  const kick = () => {
    rafId = requestAnimationFrame(loop);
  };
  const reveal = () => {
    onResize(); // 字体就绪后按真实字形重新拟合字号（回退字体度量会有偏差）
    const remain = 1000 - (performance.now() - mountedAt);
    if (remain > 0) {
      setTimeout(() => {
        fontLoading.value = false;
        kick();
      }, remain);
    } else {
      fontLoading.value = false;
      kick();
    }
  };
  const mountedAt = performance.now();
  const probe = `${FONT_WEIGHT} 22px "LXGW WenKai"`;
  // lxgw-wenkai-webfont 按 unicode-range 切片下发：probe 只喂「光阴的歌」时仅下载
  // 覆盖这 5 个字的切片，其余歌词/标题字符的切片要等画布或 DOM 真正用到才触发下载，
  // 遮罩撤掉后仍会看到雅黑→文楷的逐片跳变。把全部歌词 + 标题字符一次性喂给
  // load()，让所有相关切片就绪后再撤遮罩
  const allText =
    LINES.map((l) => l.text).join('') + '《光阴的歌》（东山少爷）';
  if (document.fonts?.load) {
    const ready = document.fonts.load(probe, allText).catch(() => {});
    // CDN 卡死兜底：8s 后无论切片是否齐了都撤遮罩，避免永久转圈
    const bail = new Promise((resolve) => setTimeout(resolve, 8000));
    Promise.race([ready, bail]).then(reveal);
  } else {
    reveal(); // 无 Font Loading API（兜底）：满 1s 撤遮罩
  }
});

onBeforeUnmount(() => {
  disposed = true;
  cancelAnimationFrame(rafId);
  fontLinkEl?.remove(); // 字体 CSS 仅本页需要，离开时移除
});
</script>

<style scoped>
.txt-scroll {
  /* 限高触发滚动：减去面板上下 padding 与标题行高度（面板总高 100dvh） */
  max-height: calc(100vh - 70px);
  max-height: calc(100dvh - 70px);
  overflow-y: auto;
  padding-right: 6px; /* 滚动条与文字留些距离 */
}
.txt-line {
  display: block;
}
.txt-gap {
  margin-top: 24px; /* 段落间隙（与画布内段落间隙视觉对齐） */
}
.lyric-canvas {
  display: block;
  width: 100%;
  height: 100%;
  background: #0d1b2a;
}
/* 顶部进度条：贴舞台顶边，不拦截交互 */
.lyric-progress {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: rgba(255, 255, 255, 0.12);
  z-index: 31;
  pointer-events: none;
}
.lyric-progress-bar {
  display: block;
  width: 0;
  height: 100%;
  background: var(--color2);
  box-shadow: 0 0 8px color-mix(in srgb, var(--color2) 80%, transparent);
}
</style>
