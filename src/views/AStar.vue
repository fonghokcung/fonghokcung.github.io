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
        起点（左下）→ 终点（右上），随机路网自动生成并保证有解；
        <br />
        首轮为全联通网格（每点与 8 邻全连），便于理解搜索扩散形态，
        网格配色两套轮换；
        <br />
        每 3 轮有 1 轮在右上区域布一道 L 形隔墙（横竖约占网格 2/3，
        墙点与四周断开），最短路径须绕过墙端缺口；
        <br />
        蓝=开放集（正在处理），<br />黄=A* 已定案区域， <br />黄粗线=A*
        实时最短路链（速度最快，但可能不是最优解）， <br />白=BFS
        广度优先对照搜索的 撒网范围， <br />白粗线=BFS 实时探测链（与 A*
        重叠处显示 A* 颜色）；
        <br />
        搜寻完成后 10s 重开新一轮
      </p>
    </template>

    <template #stage>
      <canvas ref="canvasRef" class="astar-canvas"></canvas>
    </template>
  </ThreeLayout>
</template>

<script setup>
/* A* 搜寻算法演示（纯 2D Canvas，早年原作的移植版）
 *
 * 一轮的生命周期（两阶段完成制）：
 *   生成路网（8 邻接 + rate 概率随机抽边）→ BFS 校验连通性（不连通
 *   则整网重造，重造时逐步加密抽边率提高小网格的连通概率）→ A* 与
 *   BFS 同帧率各走一步竞速 → A* 松弛到终点即 astarDone（停步定格
 *   黄链）→ BFS 到达终点才 complete：bfsFlush 染白定格撒网范围 →
 *   停留 10s 换底色重开。
 *
 * 性能设计（全联通网格 E≈4V、V 数千时的掉帧治理）：
 *   - 三层分离渲染：边层每轮静态烘焙，顶点层按集合变动增量更新，
 *     路径层（两算法实时路径链）每帧全清重画；每帧仅三次 drawImage
 *     合成 + 底部状态文字，成本与 V/E 无关；
 *   - 集合成员判定走 state 数组 O(1)，替代 includes 线性扫描；
 *   - DPR 适配：位图 ×devicePixelRatio + setTransform，视网膜屏锐利。
 *
 * 视觉体系（全部集中在 STYLE 配置，按信息重要性分三层）：
 *   - 背景层：路网底边/顶点/隔墙，1px 网格色，全程不变；
 *   - 范围层：已定格的涉足区（A* 关闭集黄、BFS 撒网白），统一 α0.4
 *     半透明、点线同色，整体「退后」；
 *   - 前景层：两算法实时路径链，4px 实心（黄=A* 白=BFS），最抢眼。
 *   开放集蓝点实心是「正在处理」的活跃信号。渲染优先级 A* > BFS——
 *   A* 已涉足的点不被 BFS 染色，直观呈现「少走弯路」对比。
 *
 * 结构：class Astar（算法与绘制，保留原作 var f = this 风格）+
 * 组件侧（实例持有 / raf 驱动 / 10s 重启定时 / 移动端判定）。
 * 原作 window.onload 的文案淡出交互由 ThreeLayout 常驻文案面板替代 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import ThreeLayout from '@/components/ThreeLayout.vue';

const layoutRef = ref(null);
const canvasRef = ref(null);

let canvasEl = null;
let rafId = 0;
let disposed = false;

/* ---- 演示设置项（改这里即可调整演示形态） ---- */
// 网格单位长度（px）：相邻格点间距。原作 12px 路网偏稠密（点挨点），
// 20px 点距更大、观感更清爽；调小即回到高密度蜂网
const GRID_SIZE = 20;
// 「大格局」：每 BIG_GRID_EVERY 轮有 1 轮（每轮组的末轮命中：
// iInter % N === N-1）把网格放大到 BIG_GRID_SIZE——与 L 形隔墙同节奏
// 但彼此独立：这里只看轮次切尺寸，不关心该轮是否建墙
const BIG_GRID_EVERY = 5;
const BIG_GRID_SIZE = 40;
// 「翻墙局」周期：每 WALL_EVERY 轮有 1 轮（每轮组的末轮命中）在右上
// 区域布一道 L 形隔墙，强制最短路径绕行墙端缺口
const WALL_EVERY = 3;
// 路网稀密档位：'sparse' 稀疏图 / 'medium' 中等（原作手感）/ 'dense' 稠密图。
// 对应 8 邻随机抽边概率（rate），越大每个点连出的边越多、路网越密：
//   sparse → E≈0.5V，路径迂回明显；medium → E≈0.8V；dense → E≈1.4V
const DENSITY = 'medium';
const DENSITY_RATE = { sparse: 0.12, medium: 0.2, dense: 0.35 };
// 首轮全联通演示开关：true = 第一次布网生成全联通网格（每点与 8 邻全连），
// 直观展示「理想路网」下 A* 的搜索扩散形态；首轮走完即恢复随机抽边。
// 改 false 关闭此额外功能，首轮即随机路网
const ALL_CONN = true;

/* ---- 视觉配置（STYLE）：全部颜色/线宽/半径的唯一来源 ----
 * 三层视觉体系，按「信息重要性」从后往前：
 *   1. 背景层（LAYER_BG）    —— 静态路网：底边/顶点/隔墙，1px 网格色，全程不变
 *   2. 范围层（LAYER_RANGE） —— 已定格的搜索范围：半透明 α0.4，点线同色系，
 *                              整体「退后」，弱于算法主色（蓝/黄实心）
 *   3. 前景层（LAYER_LIVE）  —— 活跃信号：实时路径链 4px 实心，始终最抢眼
 * 调整任何颜色/粗细只改这个对象，各绘制函数只从这里读值 */
const STYLE = {
  // 背景层：路网本体（无透明度，与深灰底拉开即可）
  LAYER_BG: {
    edgeWidth: 1, // 路网底边线宽
  },
  // 范围层：A*/BFS 已定格的涉足区（点与连线同色同透明度 = 范围成片）
  LAYER_RANGE: {
    lineWidth: 1, // 范围连线线宽（与背景层底边同档）
    closedPoint: 'rgba(251, 213, 9, 0.3)', // A* 关闭集黄点/黄-黄边
    bfsPoint: 'rgba(255, 255, 255, 0.3)', // BFS 白点/白-白边
  },
  // 前景层：两算法实时路径链（canvas 后画盖先画：白链先、黄链后）
  LAYER_LIVE: {
    lineWidth: 4, // 实时链线宽（唯一的粗线 = 唯一的动态焦点）
    bfsColor: '#fff', // BFS 探测链：白
    // A* 链颜色 = STYLE.PALETTES[*].closed 主题黄（实心）
  },
  // 顶点半径（所有格点统一，含范围层点）
  POINT_RADIUS: 2,
  // 起点/终点标记半径（唯一的大圆点 = 搜索两端锚点）
  ENDPOINT_RADIUS: 5,
  // 轮次交替配色：iInter & 1 轮流取用。仅网格/文字底色（base）随轮切换，
  // 算法语义色（open/closed）两轮固定——开放集蓝/关闭集黄是「语言」，
  // 不随底色变；closed 亦作 A* 实时链与状态文字的颜色（实心主题黄）
  // base 用暗淡色（canvas 底 #141414 的微亮变体）：路网隐入暗夜只剩
  // 隐约纹理，算法活动的点与线成为黑暗中的光——「暗夜探路」的意境；
  // 两轮明度接近、仅色相有别（冷青蓝 ⇄ 暖灰），轮换时不产生跳变感
  PALETTES: [
    {
      // 蓝底轮：路网/文字 = 暗夜冷青（底色 #141414 的微亮蓝移）
      base: '#1e2f3f',
      open: '#3d98ff', // 开放集：电光蓝（固定）
      closed: '#fbd509', // 关闭集：主题黄（固定）
    },
    {
      // 灰底轮：路网/文字 = 暗夜暖灰（同明度、色相偏暖）
      base: '#333333',
      open: '#3d98ff',
      closed: '#fbd509',
    },
  ],
};

class Astar {
  constructor(canvas) {
    this.eleCanvas = canvas;
    this.ctx = canvas.getContext('2d');

    // 起终点标记色：读全局色板 --color3（绿 #51cd85）。
    // canvas 上下文不认 CSS 变量，只能经 computed style 取值缓存
    this.colorEndPoints = getComputedStyle(document.documentElement)
      .getPropertyValue('--color3')
      .trim();

    this.d = GRID_SIZE; // 网格单位长度（px），设置项见文件头
    this.dBig = BIG_GRID_SIZE; // 「大格局」轮的网格单位长度

    this.n = -1; // raf 帧计数（驱动搜寻步进与 loading 点动画）
    this.interval = 1; // 每 N 帧搜一步（1 = 每帧一步）
    this.currentStep = -1; // 当前搜寻步数（n / interval）
    this.rate = DENSITY_RATE[DENSITY]; // 邻边抽取概率（设置项 DENSITY 档位）
    this.rateBoost = 0; // 连通性守卫重造时的抽边率临时增量（每轮内部使用）

    // 舞台尺寸与网格原点由外部（resize）注入：
    //   stageW/H 舞台 CSS 尺寸；rows/cols 网格行列数；
    //   ox/oy 网格原点（离屏层 translate 与主画布起终点标记共用，
    //   移动端避让汉堡按钮）
    this.stageW = 0;
    this.stageH = 0;
    this.rows = 0;
    this.cols = 0;
    this.ox = 25.5;
    this.oy = 20.5;
    this.isMobile = false; // 移动端标记（resize 注入，决定原点避让）

    this.regens = 0; // 当前轮因不连通已重造的次数

    // BFS 对照组：同一张路网、同一个起点，与 A* 同帧率各走一步——
    // 白色点线 = BFS 涉足范围（盲目扩散），直观对比 A* 启发式搜索的
    // 「直奔终点」与 BFS 的「全面撒网」。渲染优先级：A* 先占的点
    // （开放/关闭/路径）保持 A* 颜色，BFS 只染 A* 尚未涉足的点。
    // 白色值在 STYLE.LAYER_RANGE.bfsPoint（α0.4），此处只留运行状态
    this.bfsQueue = []; // BFS 待访问队列
    this.bfsState = []; // 0未发现 1已入队 2已出队
    this.bfsParent = []; // BFS 前驱：bfsParent[w] = 入队来源（当前路径回溯用）
    this.bfsDone = false; // BFS 到达终点（此后停止扩散，白域定格）
    this.astarDone = false; // A* 到达终点（此后停止扩张，黄链定格，等 BFS 收官）
    this.astarHead = -1; // A* 黄链头：平时 = 最新定案点，astarDone 后 = 终点

    // 首轮全联通开关：由组件侧注入（ALL_CONN），仅第一局生效
    this.firstFullConn = false;
  }

  // 舞台尺寸变化：重算行列数与网格原点，然后重启当前轮。
  // isMobile：移动端下网格原点整体右移/下移，避让 App.vue 固定在
  // 左上角（12,12，44×44）的汉堡菜单按钮。
  // 注意：「大格局」的网格尺寸切换也在这里按轮次判定——
  // 所以轮次重启必须走 resize 而非直接 init（见组件侧 onRestart）
  resize(w, h, iInter, isMobile) {
    this.stageW = w;
    this.stageH = h;
    this.isMobile = !!isMobile;
    // 「大格局」轮：网格单位放大到 dBig（每 BIG_GRID_EVERY 轮 1 轮，
    // 轮组末轮命中，与 L 形隔墙同节奏但彼此独立——只看轮次，不关心是否建墙）
    this.d =
      iInter % BIG_GRID_EVERY === BIG_GRID_EVERY - 1 ? this.dBig : GRID_SIZE;
    // 网格原点（离屏层 translate 与主画布起终点标记共用）：
    //   PC：25.5/20.5（0.5 对齐像素网格，1px 线更锐利）
    //   移动端：各 +44，让开汉堡按钮的 12~56px 区间
    this.ox = this.isMobile ? 69.5 : 25.5;
    this.oy = this.isMobile ? 64.5 : 20.5;
    // 行列数 = 可绘区尺寸 / 网格单位：
    //   上/左已由原点占位；右边留 25 呼吸位；
    //   下留 60px 给全屏按钮（bottom:14px + 高 36px = 占 50px），
    //   否则起点（左下）会被按钮盖住
    this.rows = ((h - this.oy - 60) / this.d) >> 0;
    this.cols = ((w - this.ox - 25) / this.d) >> 0;
    if (this.rows < 2 || this.cols < 2) return; // 舞台过小不布网
    this.init(iInter);
  }

  init(iInter) {
    var i;
    // ---- 本轮状态全部复位（resize / 10s 重启都会整轮重来）----
    // 本轮配色：从 STYLE.PALETTES 按轮次取用（实例缓存一份，绘制热路径免查配置）
    var palette = STYLE.PALETTES[iInter & 1]; // iInter&1 交替两套底色
    this.colorDefault = palette.base;
    this.colorOpenSet = palette.open;
    this.colorClosedSet = palette.closed;
    this.adj = []; // 邻接表：adj[v].neighbor = 与 v 相邻的顶点下标

    this.cameFrom = []; // 路径前缀：cameFrom[v] = 松弛时 v 的来源顶点
    this.result = []; // 最短路径（顶点序列，success 时回溯一次）
    this.s = 0; // 起点下标（网格左下角）
    this.closedSet = []; // 已定案顶点
    this.openSet = []; // 已发现、待处理顶点
    this.gScore = []; // g(v)：起点到 v 的实际代价
    this.fScore = []; // f(v) = g(v) + h(v)：经 v 到终点的估计代价
    this.V = this.rows * this.cols; // 顶点数
    this.E = 0; // 边数（init 内统计，暂无展示出口，保留供调试）

    this.complete = false;
    this.n = -1;
    this.currentStep = -1;
    this.restartPending = false; // 复位：防 resize 打断后完成态无法再排重启
    this.wallEdges = []; // 复位隔墙标记：非「翻墙局」不得残留上一轮的墙线

    // BFS 对照组复位：起点入队
    this.bfsQueue = [this.s];
    this.bfsState = new Array(this.V).fill(0);
    this.bfsState[this.s] = 1;
    this.bfsParent = new Array(this.V).fill(-1);
    this.bfsDone = false;
    this.astarDone = false;
    this.astarHead = -1;
    //====================================
    // 重设 canvas 尺寸（顺带清空画布）。
    // DPR 适配：位图尺寸 = CSS 尺寸 × devicePixelRatio，再 scale(dpr)
    // 让绘制坐标系保持 CSS 像素不变——否则视网膜屏上位图被拉伸，
    // 1px 边线和文字都会模糊
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.eleCanvas.width = this.stageW * this.dpr;
    this.eleCanvas.height = this.stageH * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // 离屏分层渲染：边层（每轮静态画一次）+ 顶点层（按状态增量画）
    // + 路径层（每帧全清重画两算法实时路径链，见 drawLivePaths）。
    // 全联通网格 E≈4V、V 数千，逐帧全量重绘（O(V+E) 次描边 + 旧版
    // includes 的 O(V²) 集合扫描）会明显掉帧；分层后每帧只是三次
    // drawImage 合成 + 底部文字，成本近乎常数。
    // 离屏层同样按 dpr 放大，drawImage 时反向缩放回 CSS 尺寸
    this.state = new Array(this.V).fill(0); // 0未涉足 1开放集 2关闭集 3路径
    this.edgeLayer = document.createElement('canvas');
    this.edgeLayer.width = this.stageW * this.dpr;
    this.edgeLayer.height = this.stageH * this.dpr;
    this.lctxE = this.edgeLayer.getContext('2d');
    this.lctxE.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.lctxE.translate(this.ox, this.oy); // 与主画布同一坐标原点
    this.vertexLayer = document.createElement('canvas');
    this.vertexLayer.width = this.stageW * this.dpr;
    this.vertexLayer.height = this.stageH * this.dpr;
    this.lctxV = this.vertexLayer.getContext('2d');
    this.lctxV.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.lctxV.translate(this.ox, this.oy);
    // 路径层：两算法「当前点 → 起点」的实时路径链，每帧清空重画
    // （链会随松弛/出队不断改挂，增量画反而更贵，全清重画最简单）
    this.pathLayer = document.createElement('canvas');
    this.pathLayer.width = this.stageW * this.dpr;
    this.pathLayer.height = this.stageH * this.dpr;
    this.lctxP = this.pathLayer.getContext('2d');
    this.lctxP.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.lctxP.translate(this.ox, this.oy);
    this.lctxP.lineCap = 'round';

    // 布网方式：首轮且开关开启 → 全联通网格（8 邻全连），帮助理解
    // 「理想路网」下的搜索扩散形态；之后各轮随机抽边。
    // 注意：firstFullConn 由组件侧在首轮注入，走完即被 onRestart 关闭
    if (this.firstFullConn) {
      this.initAdjFull();
    } else {
      this.initAdj();
    }
    this.openSet.push(this.s);

    // 无向图：addNeighbor/initAdjFull 的边记录需对称，doubleNeighbor 补齐
    this.doubleNeighbor();

    // 「翻墙局」：每 WALL_EVERY 轮有 1 轮（轮组末轮命中）布一道
    // L 形隔墙——拐角取位于右上 1/3 区，横竖臂长约为网格的 1/2~2/3，
    // 强制最短路径绕过墙端缺口
    if (iInter % WALL_EVERY === WALL_EVERY - 1) {
      this.buildWall();
    }

    // 连通性守卫：随机路网可能起点到不了终点（openSet 耗尽走 fail），
    // 这类局演示价值为零——BFS 从起点出发，够不着终点就整网重造。
    // 重造时抽边率逐次 +0.02 加密：小网格（大格局轮只有几十个顶点）
    // 在固定 rate 下连通概率很低，盲目重试 30 次也常撞不中
    // （实测 6×11 网格耗尽率 43/300）；定向加固后几次内必连通，
    // rateBoost 只作用于当前轮，连通后即复位
    if (!this.isConnected()) {
      this.rateBoost += 0.02;
      if (++this.regens < 30) return this.init(iInter);
    }
    this.regens = 0;
    this.rateBoost = 0;

    // A* 初始代价：起点 g=0，其余 Infinity
    for (i = 0; i < this.V; i++) {
      this.gScore[i] = Infinity;
      this.fScore[i] = Infinity;
    }
    this.gScore[this.s] = 0;
    this.fScore[this.s] = this.funHeuristic(this.s);

    // 统计边数（无向图邻接表度数之和 / 2）
    for (i = 0; i < this.V; i++) {
      this.E += this.adj[i].neighbor.length;
    }
    this.E = this.E / 2;

    // 路网定稿 → 烘焙静态图层（此后顶点层只做增量更新）
    this.bakeLayers();
  }
  // 补齐无向边：initAdj/initAdjFull 的边记录需要对称，
  // 这里对每条 u→v 的边补上 v→u，凑成无向邻接
  doubleNeighbor() {
    var f = this;
    f.adj.forEach(function (v, index) {
      f.findAllNeighbor(v.row, v.col).forEach(function (neighborIndex) {
        var neightborHasV = f.adj[neighborIndex].neighbor.includes(index);
        var vNOThasNeighbor = !v.neighbor.includes(neighborIndex);
        if (neightborHasV && vNOThasNeighbor) {
          v.neighbor.push(neighborIndex);
        }
      });
    });
    return f;
  }
  // 连通性校验：BFS 从起点涉足的所有顶点，看终点是否在内。
  // 只在 init 布网阶段调用一次，运行期不参与搜索
  isConnected() {
    var f = this;
    var seen = [];
    var queue = [f.s];
    seen[f.s] = true;
    while (queue.length) {
      var v = queue.pop();
      if (v === f.V - 1) return true;
      f.adj[v].neighbor.forEach(function (w) {
        if (!seen[w]) {
          seen[w] = true;
          queue.push(w);
        }
      });
    }
    return false;
  }
  // 启发函数 h(v)：到终点的欧氏距离 × 3。
  // 高估 3 倍破坏了可采纳性，路径不再保证全局最优，但搜索更贪婪更快，
  // 是原作有意的取舍
  funHeuristic(index) {
    return (3 * this.calcDist(index, this.V - 1)) >> 0;
  }
  // 顶点 v、w 的中心点欧氏距离
  calcDist(v, w) {
    var f = this;
    var x0 = f.index2center(v).x;
    var y0 = f.index2center(v).y;
    var x1 = f.index2center(w).x;
    var y1 = f.index2center(w).y;
    var d = Math.sqrt(Math.pow(x1 - x0, 2) + Math.pow(y1 - y0, 2));
    return d;
  }

  // 布网：按 rows×cols 逐行生成顶点，每顶点随机抽 8 邻（有向、rate 概率）
  initAdj() {
    var f = this;
    for (var i = 0; i < f.rows; i++) {
      for (var j = 0; j < f.cols; j++) {
        var index = f.ij2index(i, j);
        var objV = {
          index: index,
          row: i,
          col: j,
          neighbor: f.addNeighbor(i, j),
        };
        f.adj[index] = objV;
      }
    }
    return f;
  }
  // 布网（全联通版）：每顶点与 8 邻全部连接，网格必然连通，
  // 用于首轮直观演示「理想路网」中 A* 的搜索扩散与回溯形态
  initAdjFull() {
    var f = this;
    for (var i = 0; i < f.rows; i++) {
      for (var j = 0; j < f.cols; j++) {
        var index = f.ij2index(i, j);
        f.adj[index] = {
          index: index,
          row: i,
          col: j,
          neighbor: f.findAllNeighbor(i, j), // 8 邻全收（无随机抽边）
        };
      }
    }
    return f;
  }
  // 「翻墙局」L 形障碍：先正常出路网，再清除 L 形两臂上各点与邻居的
  // 所有联系——
  //   横臂：(r, c1)…(r, c2)  竖臂：(r2, c2)…(r, c2)（r2 < r）
  // 两臂共享拐角 (r, c2)，构成「┐」形：拐角在右上、凹口朝左下，
  // 正对左下起点的来路，最短路径必须绕到臂端缺口外再折回。
  // 臂点全部孤立后，8 邻网格里这条点带上下/左右都不可穿越（对角
  // 斜穿也无路可走——这正是只删臂内相邻边会漏的原因）；
  // 连通性守卫随后仍会兜底。横竖比例随舞台宽高比自适应
  buildWall() {
    var f = this;
    // 网格过小（不足 6×8）时放不下像样的 L 形障碍，直接跳过
    if (f.rows < 6 || f.cols < 8) return f;

    // 障碍臂定位在右上 1/3 区内随机取位（行号大 = 画布上方）：
    //   拐角行 r：上 1/3 区内（避开末行防贴边）
    //   拐角列 c2：右 1/3 区内（避开末列防贴边）
    //   横臂起点 c1：横臂向左延伸的长度随机（占 cols 的 1/2 ~ 2/3），
    //     钳制 ≥1——臂端永不贴左缘
    //   竖臂终点 r2：竖臂向下延伸（行号减小）的长度随机
    //     （占 rows 的 1/2 ~ 2/3），钳制 ≥1——臂端永不贴底缘
    // 四端都不贴边 ⇒ 墙体无法与画布边缘合围 ⇒ 臂端外侧必有可穿行
    // 缺口 ⇒ 必然有解，无需依赖连通性守卫整网重造
    var r =
      f.rows -
      2 -
      Math.floor(Math.random() * Math.max(1, Math.floor(f.rows / 3) - 1));
    var c2 =
      f.cols -
      1 -
      Math.floor(
        Math.random() * Math.max(1, f.cols - Math.floor((f.cols * 2) / 3) - 1),
      );
    var c1 = Math.max(
      1,
      c2 -
        (Math.floor((f.cols * 2) / 3) -
          Math.floor(Math.random() * Math.floor(f.cols / 6))),
    );
    var r2 = Math.max(
      1,
      r -
        (Math.floor((f.rows * 2) / 3) -
          Math.floor(Math.random() * Math.floor(f.rows / 6))),
    );

    // 收集两臂的全部格点（含共享拐角，拐角只收一次）；
    // wallEdges 记录臂内相邻点对，仅供 bakeLayers 用网格色重描一遍
    var wallVerts = [];
    this.wallEdges = [];
    var i;
    var j;
    for (j = c1; j <= c2; j++) {
      wallVerts.push(f.ij2index(r, j));
      if (j < c2) {
        this.wallEdges.push([f.ij2index(r, j), f.ij2index(r, j + 1)]);
      }
    }
    for (i = r2; i < r; i++) {
      wallVerts.push(f.ij2index(i, c2));
      this.wallEdges.push([f.ij2index(i, c2), f.ij2index(i + 1, c2)]);
    }

    // 清除各臂点与邻居的所有联系：自己的邻表清空，同时从每个
    // 前邻居的邻表摘除自己（无向图双向对称）
    wallVerts.forEach(function (idx) {
      f.adj[idx].neighbor.forEach(function (nb) {
        f.adj[nb].neighbor = f.adj[nb].neighbor.filter(function (x) {
          return x !== idx;
        });
      });
      f.adj[idx].neighbor = [];
    });
    return f;
  }
  // 行列下标 (i,j) → 顶点下标；越界返回 -1
  ij2index(i, j) {
    var f = this;
    if (i < 0 || j < 0 || i > f.rows - 1 || j > f.cols - 1) {
      return -1;
    }
    return i * f.cols + j;
  }
  // 顶点下标 → 行列下标 {i,j}；越界返回 null（当前无人调用，备用）
  index2ij(index) {
    var f = this;
    if (index < 0 || index > f.V - 1) {
      return null;
    }
    return {
      i: (index / f.cols) >> 0,
      j: index % f.cols,
    };
  }
  // 顶点下标 → 画布坐标：行方向翻转，使 index 0 落在左下角、
  // V-1 落在右上角（Canvas y 轴向下）
  index2center(index) {
    var f = this;
    var realRow = f.rows - f.adj[index].row - 1; // 行翻转：左下角为起点
    return {
      x: f.d * f.adj[index].col + f.d / 2,
      y: f.d * realRow + f.d / 2,
    };
  }
  // (i,j) 的 8 邻接下标（越界为 -1，末尾过滤掉）
  findAllNeighbor(i, j) {
    var arrDerection = [];

    // 上
    arrDerection[0] = this.ij2index(i - 1, j);
    // 上-右
    arrDerection[1] = this.ij2index(i - 1, j + 1);
    // 右
    arrDerection[2] = this.ij2index(i, j + 1);
    // 下-右
    arrDerection[3] = this.ij2index(i + 1, j + 1);
    // 下
    arrDerection[4] = this.ij2index(i + 1, j);
    // 下-左
    arrDerection[5] = this.ij2index(i + 1, j - 1);
    // 左
    arrDerection[6] = this.ij2index(i, j - 1);
    // 上-左
    arrDerection[7] = this.ij2index(i - 1, j - 1);

    // 过滤越界的 -1（+1 技巧：-1+1=0 为假值被滤掉，其余原值保留）
    return arrDerection.filter(function (v) {
      return v + 1;
    });
  }
  // 随机抽邻：8 邻中每个以 rate 概率入选（有向边，方向性由 doubleNeighbor 消除）。
  // rate 含守卫的 rateBoost：重造时逐次加密，提高小网格连通概率
  addNeighbor(i, j) {
    var f = this;
    var arrDerection = f.findAllNeighbor(i, j).filter(function () {
      return Math.random() < f.rate + f.rateBoost;
    });

    return arrDerection;
  }

  // 主循环单步（组件 raf 每帧调一次）：推进一步竞速 + 整帧重绘。
  // complete 由 BFS 收官（bfsStep）或失败兜底（watchOpenSet）置位
  step() {
    var f = this;
    f.n++;
    if (!f.complete) {
      // 搜寻中：按 interval 节流步进（interval=1 即每帧一步）
      if (!(f.n % f.interval)) {
        f.currentStep = f.n / f.interval;
        f.doINeveryframe();
      }
    } else if (!f.restartPending) {
      // 完成：走一次 success（排 10s 重启定时），此后 restartPending 挡住
      // 后续帧重复触发——画面冻结在完整路径上直到新一轮 init
      f.restartPending = true;
      f.success();
    }
    f.draw();
    return f;
  }
  // 完成回调（BFS 收官后触发）：回溯 A* 路径 + 排重启定时。
  // 不再描定稿线/对照线：关闭集连片刷黄已把 A* 路径衬出（黄底黄点
  // 自成通路），BFS 撒网白点同理自成范围——画面定格即可，无需额外线
  success() {
    var f = this;
    f.findPath();
    f.bfsFlush(); // BFS 对照组收尾：剩余已发现点一次性染白定格
    if (f.onRestart) f.onRestart();
    return f;
  }
  // 路径回溯：沿 cameFrom 前缀从终点走到起点，倒序收集成 result。
  // 每次松弛只写一次 cameFrom（O(1)），回溯仅在到达终点时发生一次
  // O(路径长)——替代原作「每条边松弛都全量倒序扫 SPT 字符串数组」的滥调。
  // fail 分支（理论上 init 已保证连通，仅当 regens 上限放行无解局）
  // cameFrom[V-1] 为 undefined，必须短路返回，否则 while 会拿 undefined
  // 当顶点死循环
  findPath() {
    var f = this;
    var end = f.V - 1;
    f.result = [];
    if (f.cameFrom[end] === undefined) return f;
    while (true) {
      f.result.unshift(end);
      if (end === f.s) break;
      end = f.cameFrom[end];
    }
    return f;
  }
  // 单步搜寻的入口（原作逐帧钩子的保留命名）：
  // A* 走一步，BFS 对照组同步走一步（各一步/帧，节奏对齐）
  doINeveryframe() {
    var f = this;
    f.watchOpenSet();
    f.bfsStep();
    return f;
  }
  // A* 核心一步：取 openSet 中 fScore 最小者 → 移入 closedSet → 松弛邻居。
  // 集合成员判定走 state 数组（O(1)），替代旧版 openSet/closedSet
  // includes 的线性扫描（O(V)×每邻居 = 全联通时 O(V²)/帧 的卡顿主因之一）。
  // astarDone（A* 已到终点，等 BFS 收官）后不再扩张
  watchOpenSet() {
    if (this.astarDone) return false;
    if (!this.openSet.length) {
      // 理论兜底：init 已保证连通，走到这里说明 regens 上限放行了无解局
      //（BFS 同样到不了终点，bfsQueue 耗尽后 complete 由 bfsStep 置位不了
      // ——补一个兜底：两队列全空即整轮失败结束）
      if (!this.bfsQueue.length) this.complete = true;
      return false;
    }
    var f = this,
      tentativeGScore;

    // openSet 按 fScore 升序排序，队首即「最有希望」的顶点
    f.openSet.sort(function (a, b) {
      return f.fScore[a] - f.fScore[b];
    });

    var current = f.openSet.shift();

    f.closedSet.push(current);
    f.astarHead = current; // 黄链头跟随最新定案点
    // 关闭集 = 黄色势力范围（范围层）：定案即刷黄点 + 与已定案邻居连黄线
    f.state[current] = 2;
    f.paintVertex(f.lctxV, current, STYLE.LAYER_RANGE.closedPoint);
    // 黄-黄边：势力范围连成片（此前黄点之间隔着网格底色细线，观感割裂）。
    // 每条黄-黄边只在后定案的一端触发一次，不会重复描线
    f.lctxV.strokeStyle = STYLE.LAYER_RANGE.closedPoint;
    f.lctxV.lineWidth = STYLE.LAYER_RANGE.lineWidth;
    f.adj[current].neighbor.forEach(function (w) {
      // state===2 = 已定案（黄点）
      if (f.state[w] === 2) {
        f.lctxV.beginPath();
        f.lctxV.moveTo(f.index2center(w).x, f.index2center(w).y);
        f.lctxV.lineTo(f.index2center(current).x, f.index2center(current).y);
        f.lctxV.closePath();
        f.lctxV.stroke();
      }
    });

    // 松弛 current 的所有邻居：已定案的跳过；
    // 经由 current 的代价更低则更新 g/f，并记 cameFrom 前缀
    for (var i = 0; i < f.adj[current].neighbor.length; i++) {
      var neighbor = f.adj[current].neighbor[i];

      if (f.state[neighbor] === 2) {
        continue;
      }

      tentativeGScore = f.gScore[current] + f.calcDist(current, neighbor);

      if (f.state[neighbor] === 0) {
        f.state[neighbor] = 1; // 首次发现 → 开放集，增量画上顶点层
        f.openSet.push(neighbor);
        f.paintVertex(f.lctxV, neighbor, f.colorOpenSet);
      } else if (tentativeGScore >= f.gScore[neighbor]) {
        continue;
      }

      f.cameFrom[neighbor] = current;
      f.gScore[neighbor] = tentativeGScore;
      f.fScore[neighbor] = f.gScore[neighbor] + f.funHeuristic(neighbor);

      // A* 到达终点：只置 astarDone 停止扩张，整轮等 BFS 也到终点
      // 才算 complete——BFS 是无权图最短路基准，两路径重合与否
      // 即可验证 A*（启发 ×3 破坏可采纳性）找的是否真是最短路。
      // 注意：终点不进 closedSet（直接 return），黄链头单独指向它，
      // 否则实时黄链会缺最后一跳
      if (neighbor === f.V - 1) {
        this.astarHead = f.V - 1;
        this.astarDone = true;
        return true;
      }
    }

    return f;
  }

  // 染白一个 BFS 顶点（v 刚出队或 flush 定格），并把它与所有
  // 「已是白点」的邻居用白线连起来——图上的白-白边全部可见：
  // 父边（父先出队）+ 兄弟边（同层互邻）都覆盖；每条边只在
  // 后出队的一端触发一次，不会重复描线。
  // 仅当两端都处于 A* 空白区（state===0）才画，A* 颜色优先级不变
  paintBfsVertex(v) {
    var f = this;
    f.paintVertex(f.lctxV, v, STYLE.LAYER_RANGE.bfsPoint);
    f.lctxV.strokeStyle = STYLE.LAYER_RANGE.bfsPoint;
    f.lctxV.lineWidth = STYLE.LAYER_RANGE.lineWidth;
    f.adj[v].neighbor.forEach(function (w) {
      // bfsState===2 = 已出队（白点）；两端都得是 A* 空白
      if (f.bfsState[w] === 2 && f.state[w] === 0) {
        f.lctxV.beginPath();
        f.lctxV.moveTo(f.index2center(w).x, f.index2center(w).y);
        f.lctxV.lineTo(f.index2center(v).x, f.index2center(v).y);
        f.lctxV.closePath();
        f.lctxV.stroke();
      }
    });
    return f;
  }
  // BFS 对照组单步（与 watchOpenSet 同帧率各走一步）：
  // 出队一顶点 → 染白 + 连白所有白邻居 → 未发现邻居入队。
  // A* 先到终点后 BFS 继续跑（整轮以 BFS 收官为准）；
  // BFS 到达终点：回溯自己的最短路径 + 置 complete 结束整轮
  bfsStep() {
    var f = this;
    if (f.bfsDone || !f.bfsQueue.length) return f;
    var v = f.bfsQueue.shift();
    f.bfsState[v] = 2;
    // 白点/白线只画在 A* 的空白区（state===0）；A* 已涉足的点保持
    // A* 颜色与网格底色
    if (f.state[v] === 0) {
      f.paintBfsVertex(v);
    }
    if (v === f.V - 1) {
      // BFS 收官：从终点沿 bfsParent 回溯最短路（终点→起点，再反转）
      f.bfsResult = [];
      var w = f.V - 1;
      while (w >= 0) {
        f.bfsResult.unshift(w);
        if (w === f.s) break;
        w = f.bfsParent[w];
      }
      f.bfsDone = true;
      f.complete = true; // 两算法都到终点 → 整轮完成
      return f;
    }
    f.adj[v].neighbor.forEach(function (w) {
      if (f.bfsState[w] === 0) {
        f.bfsState[w] = 1;
        f.bfsParent[w] = v;
        f.bfsQueue.push(w);
      }
    });
    return f;
  }
  // BFS 完场收尾（A* success 时调用一次）：把 BFS 队列里剩余的
  // 已发现点一次性染白定格（含白-白连线），完整呈现「BFS 撒网范围」
  bfsFlush() {
    var f = this;
    f.bfsQueue.forEach(function (v) {
      if (f.state[v] === 0) {
        f.paintBfsVertex(v);
      }
    });
    f.lctxV.lineWidth = 1;
    return f;
  }

  // 实时路径链：两算法「当前执行的点」沿各自前驱回溯到起点的路径，
  // 每帧在路径层全清重画——前景层 4px 实心（宽/色读 STYLE.LAYER_LIVE）。
  // A* 链 = cameFrom[当前关闭点]；BFS 链 = bfsParent[当前队首]。
  // 每步松弛/入队都可能改挂前驱，增量维护反而更贵，全清重画最省心；
  // 链长 O(路径长)，每帧 O(链长) 次描边可忽略不计
  drawLivePaths() {
    var f = this;
    if (f.complete) return f; // 完成后 path 层清空，画面定格在范围层
    f.lctxP.setTransform(1, 0, 0, 1, 0, 0);
    f.lctxP.clearRect(0, 0, f.pathLayer.width, f.pathLayer.height);
    f.lctxP.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
    f.lctxP.translate(f.ox, f.oy);
    f.lctxP.lineWidth = STYLE.LAYER_LIVE.lineWidth;
    // 绘制顺序 = 层级：白链先画、黄链后画（canvas 后画盖先画），
    // 两链重叠段黄线始终盖在白线上面——A* 是主角
    // BFS 链：当前队首（下一个待出队点）→ 起点，一眼盯住 BFS 的「当前触手」
    if (f.bfsQueue.length && !f.bfsDone) {
      f.lctxP.strokeStyle = STYLE.LAYER_LIVE.bfsColor;
      var b = f.bfsQueue[0];
      f.lctxP.beginPath();
      f.lctxP.moveTo(f.index2center(b).x, f.index2center(b).y);
      while (f.bfsParent[b] >= 0 && b !== f.s) {
        b = f.bfsParent[b];
        f.lctxP.lineTo(f.index2center(b).x, f.index2center(b).y);
      }
      f.lctxP.stroke();
    }
    // A* 链：黄链头（astarHead，见 watchOpenSet）→ 起点。astarDone
    // 后链头定格在终点，链完整显示「A* 认为的最短路」——供 BFS
    // 收官前的等待期观者审视（4px 实心黄，压过 α0.4 的关闭集底色）
    if (f.astarHead >= 0) {
      f.lctxP.strokeStyle = f.colorClosedSet;
      var v = f.astarHead;
      f.lctxP.beginPath();
      f.lctxP.moveTo(f.index2center(v).x, f.index2center(v).y);
      while (f.cameFrom[v] !== undefined && v !== f.s) {
        v = f.cameFrom[v];
        f.lctxP.lineTo(f.index2center(v).x, f.index2center(v).y);
      }
      f.lctxP.stroke();
    }
    return f;
  }

  // 整帧合成：边层 + 顶点层 + 路径层三张离屏画布 drawImage 到主画布，
  // 再叠底部状态文字与起终点标记。每帧成本近乎常数（与 V/E 无关）。
  // 离屏位图是 CSS 尺寸 ×dpr，按 CSS 尺寸画回（主 ctx 已 scale(dpr)，
  // 位图 1:1 贴到物理像素，保持锐利）
  draw() {
    var f = this;
    f.ctx.clearRect(0, 0, f.stageW, f.stageH);
    f.ctx.drawImage(f.edgeLayer, 0, 0, f.stageW, f.stageH);
    f.ctx.drawImage(f.vertexLayer, 0, 0, f.stageW, f.stageH);
    f.drawLivePaths();
    f.ctx.drawImage(f.pathLayer, 0, 0, f.stageW, f.stageH);
    f.drawTextAndStartEnd();
    return f;
  }
  // 每轮一次：把整张路网（边 + 顶点）画到边层/顶点层离屏画布上。
  // 边层全程不变；顶点层之后只做增量更新（watchOpenSet / paintBfsVertex
  // / success）；路径层不在此烘焙（每帧全清重画）
  bakeLayers() {
    var f = this,
      i;
    // clearRect 用位图物理尺寸（setTransform(dpr) 后按 CSS 坐标清不全）
    f.lctxE.setTransform(1, 0, 0, 1, 0, 0);
    f.lctxE.clearRect(0, 0, f.edgeLayer.width, f.edgeLayer.height);
    f.lctxE.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
    f.lctxE.translate(f.ox, f.oy);
    f.lctxV.setTransform(1, 0, 0, 1, 0, 0);
    f.lctxV.clearRect(0, 0, f.vertexLayer.width, f.vertexLayer.height);
    f.lctxV.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
    f.lctxV.translate(f.ox, f.oy);
    f.lctxE.fillStyle = f.colorDefault;
    f.lctxE.strokeStyle = f.colorDefault;
    f.lctxE.lineWidth = STYLE.LAYER_BG.edgeWidth;

    for (i = 0; i < f.adj.length; i++) {
      f.drawEdgeOn(f.lctxE, i);
    }
    for (i = 0; i < f.adj.length; i++) {
      f.paintVertex(f.lctxV, i, f.colorDefault);
    }
    // 隔墙标记：不特殊着色——沿 L 形两臂重复描一遍网格色即可（臂点已
    // 孤立，存在的意义是「断边」，无需视觉强调；保持与路网底边一致）
    if (f.wallEdges && f.wallEdges.length) {
      f.lctxE.strokeStyle = f.colorDefault;
      f.lctxE.lineWidth = STYLE.LAYER_BG.edgeWidth;
      f.wallEdges.forEach(function (e) {
        f.lctxE.beginPath();
        f.lctxE.moveTo(f.index2center(e[0]).x, f.index2center(e[0]).y);
        f.lctxE.lineTo(f.index2center(e[1]).x, f.index2center(e[1]).y);
        f.lctxE.stroke();
      });
    }
    return f;
  }
  // 在指定上下文画单个顶点（离屏层专用；半径读 STYLE.POINT_RADIUS）
  paintVertex(ctx, index, color) {
    var f = this;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(
      f.index2center(index).x,
      f.index2center(index).y,
      STYLE.POINT_RADIUS,
      0,
      2 * Math.PI,
      true,
    );
    ctx.fill();
    ctx.closePath();
    ctx.stroke();
  }
  // 在指定上下文画顶点 index 的所有邻边（index<v 只画一次避免双向重复）
  drawEdgeOn(ctx, index) {
    var f = this;

    f.adj[index].neighbor.forEach(function (v) {
      if (index < v) {
        ctx.beginPath();
        ctx.moveTo(f.index2center(index).x, f.index2center(index).y);
        ctx.lineTo(f.index2center(v).x, f.index2center(v).y);
        ctx.closePath();
        ctx.stroke();
      }
    });
    return f;
  }
  // 底部状态文字（三段：搜寻中 / A* 已到终点等 BFS / 已完成）
  // 与起终点标记。文字水平居中画在底边避让带里，
  // 距离左下角全屏按钮（left:14 起、宽 36px）足够远，不会被盖住。
  // 抖动细节：loading 点数 1~3 循环会让字符串总宽变化，若整体居中
  // 每帧都会左右挪——把文字与点拆成两次绘制，文字以定宽整体居中
  // （按最大点数 3 预留宽度后取中心），点从文字右缘外起笔左对齐，
  // 文字纹丝不动、只有点在动
  drawTextAndStartEnd() {
    var f = this;
    // 文字画在主画布坐标系（无 translate 偏移）；13px 与旧版一致
    f.ctx.font = '13px "Microsoft JhengHei"';
    f.ctx.fillStyle = f.colorClosedSet;
    var label;
    var dots = '';
    if (f.complete) {
      label = '已完成';
    } else if (f.astarDone) {
      // A* 已到终点，等 BFS 收官做路径比对（此时 A* 链已定格）
      label = 'A* 已到终点，等待 BFS';
      // loading 点动画：draw 每帧重绘，帧计数驱动点数 1→2→3 循环，
      // n>>3 每 8 帧变一次（约 133ms @60fps）
      dots = '.'.repeat(((f.n >> 3) % 3) + 1);
    } else {
      label = '搜寻中';
      dots = '.'.repeat(((f.n >> 3) % 3) + 1);
    }
    // 定宽居中：最大形态（label + 3 点）的中心 = 画布中心，
    // 文字锚点 = 中心 − 最大总宽/2，不随当前点数变化
    f.ctx.textAlign = 'left';
    var dotsMaxWidth = f.ctx.measureText('...').width;
    var labelX =
      f.stageW / 2 - (f.ctx.measureText(label).width + dotsMaxWidth) / 2;
    f.ctx.fillText(label, labelX, f.stageH - 19.5);
    if (dots) {
      f.ctx.fillText(
        dots,
        labelX + f.ctx.measureText(label).width,
        f.stageH - 19.5,
      );
    }

    // 起终点标记：终点 V-1（右上）与起点 0（左下），--color3 绿色。
    // index2center 返回网格坐标系（带 translate(ox,oy) 偏移），
    // 主画布无偏移，这里手动加上；半径读 STYLE.ENDPOINT_RADIUS
    f.ctx.fillStyle = f.colorEndPoints;
    f.ctx.arc(
      f.index2center(f.V - 1).x + f.ox,
      f.index2center(f.V - 1).y + f.oy,
      STYLE.ENDPOINT_RADIUS,
      0,
      2 * Math.PI,
      true,
    );
    f.ctx.closePath();
    f.ctx.arc(
      f.index2center(0).x + f.ox,
      f.index2center(0).y + f.oy,
      STYLE.ENDPOINT_RADIUS,
      0,
      2 * Math.PI,
      true,
    );
    f.ctx.closePath();
    f.ctx.fill();

    return f;
  }
} // class

/* ---- 组件侧：实例持有 + raf 驱动 + 10s 重启定时 ----
 * 职责边界：class Astar 只管「一轮」的算法与绘制；
 * 跨轮的轮次计数、定时重启、移动端判定、卸载清理都在组件侧 */
let astar = null;
let restartTimer = null;
let iInter = 0; // 轮次计数：iInter&1 交替两套网格底色，也驱动墙局/大格局节拍

function loop() {
  rafId = requestAnimationFrame(loop);
  if (disposed || !astar) return;
  astar.step();
}

// 舞台尺寸变化（ResizeObserver → stage-resize，含文案收展/窗口缩放/
// 全屏切换）：首进场创建实例并注入重启回调，此后每次交给 resize 布网。
// 移动端判定：视口 <768px（与 ThreeLayout 的桌面断点一致）——
// 移动端下 resize 会让网格原点避让 App.vue 左上角的汉堡菜单按钮
function onResize() {
  if (!canvasEl || disposed) return;
  const container = layoutRef.value?.stageRef;
  if (!container) return;
  const rect = container.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const isMobile = window.innerWidth < 768;
  if (!astar) {
    astar = new Astar(canvasEl);
    astar.iInter = iInter;
    // 首轮全联通网格（额外演示功能，ALL_CONN 开关）：帮观者先看到
    // 理想路网下的完整搜索形态；首轮走完即关闭，后续轮恢复随机路网
    if (ALL_CONN) astar.firstFullConn = true;
    // 原作 success() 直接重开新一轮（页面级脚本无卸载概念）；移植版把
    // 重启定时挪到组件侧：完成 → 10s 后换底色重开（两算法路径比对
    // 需要停留时间供观者审视），卸载时可 clearTimeout 拦截，
    // 防止离屏后仍定时重开
    astar.onRestart = function () {
      iInter++;
      this.iInter = iInter;
      this.firstFullConn = false; // 首轮演示结束，恢复随机布网
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (disposed || !astar) return;
        astar.restartPending = false;
        // 重启必须走 resize 而非直接 init：网格单位 d 的「大格局」切换
        // 逻辑在 resize 里按轮次判定，直接 init 会沿用上一轮的 d，
        // 导致 BIG_GRID_SIZE 永远不生效
        astar.resize(astar.stageW, astar.stageH, iInter, astar.isMobile);
      }, 1e4);
    };
  }
  astar.resize(
    Math.round(rect.width),
    Math.round(rect.height),
    iInter,
    isMobile,
  );
}

onMounted(() => {
  canvasEl = canvasRef.value;
  onResize();
  loop();
});

onBeforeUnmount(() => {
  disposed = true;
  cancelAnimationFrame(rafId);
  clearTimeout(restartTimer);
});
</script>

<style scoped>
.astar-canvas {
  display: block;
  width: 100%;
  height: 100%;
  /* 深灰而非纯黑：与侧栏 --color-bg-dark（#090c09，亮度 4%）拉开层次，
     避免常驻菜单与画布粘连成一片；亮一档也让「暗舞台」有纵深 */
  background: #141414;
}
/* 零件名标注链接进官网：主题色 + hover 下划线，融进正文排版 */
.as-link {
  color: var(--color2);
  text-decoration: none;
  border-bottom: 1px dashed currentcolor;
}
.as-link:hover {
  text-decoration: underline;
}
</style>
