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
        起点（左下）→
        终点（右上），随机路网自动生成并保证有解，（网格底色两套轮换）
        <br />
        首轮为全联通网格（每点与 8 邻全连），便于理解搜索扩散形态；
        <br />
        搜寻完成后 4s 重开新一轮；
        <br />
        蓝=开放集，
        <br />黄=关闭集，<br />黄线=最短路径
      </p>
    </template>

    <template #stage>
      <canvas ref="canvasRef" class="astar-canvas"></canvas>
    </template>
  </ThreeLayout>
</template>

<script setup>
/* A* 搜寻算法演示（纯 2D Canvas，早年原作的移植版）
 * 随机生成无向路网（8 邻接 + rate 概率抽边），init 时 BFS 校验连通性，
 * 保证起点（左下）到终点（右上）必有解；A* 每帧从 openSet 取 fScore
 * 最小的顶点扩张，closedSet 记录已处理，cameFrom 前缀数组记录松弛来源，
 * 到达终点后一次性回溯出最短路径。搜寻完成后停留 4s（含 loading 点动画），
 * 换底色重开新一轮。原作的全局 iInter 改为实例字段，window.onload 的
 * 文案淡出交互由左侧常驻文案面板替代 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import ThreeLayout from '@/components/ThreeLayout.vue';

const layoutRef = ref(null);
const canvasRef = ref(null);

let canvasEl = null;
let rafId = 0;
let disposed = false;

class Astar {
  constructor(canvas) {
    this.eleCanvas = canvas;
    this.ctx = canvas.getContext('2d');

    // 配色：开放集=电光蓝、关闭集=路径=主题黄 #FBD509（--color-primary），
    // 两轮固定不变；仅网格/文字底色随 iInter 交替（青蓝 ⇄ 中性灰）。
    // 关闭集与路径同为黄色：搜寻全程铺开「黄色势力范围」，抵达终点时
    // 最短路径以 3px 粗线从黄腹地中浮出，同色不同层级
    this.PALETTES = [
      {
        // 蓝底轮：网格/文字 = 高饱和青蓝
        base: '#2f6f9f',
        open: '#3d98ff', // 开放集：电光蓝（固定）
        closed: '#fbd509', // 关闭集：主题黄（固定）
        path: '#fbd509', // 最短路径：主题黄（固定）
      },
      {
        // 灰底轮：网格/文字 = 中性灰
        base: '#8a8a8a',
        open: '#3d98ff',
        closed: '#fbd509',
        path: '#fbd509',
      },
    ];
    this.d = 12; // 网格单位长度（px）

    this.n = -1; // raf 帧计数（驱动搜寻步进与 loading 点动画）
    this.interval = 1; // 每 N 帧搜一步（1 = 每帧一步）
    this.currentStep = -1; // 当前搜寻步数（n / interval）
    this.rate = 0.2; // 邻边抽取概率（越大路网越密）
    this.SPTw = 3; // 最短路径（SPT）线宽 px，顶点半径 = SPTw - 1

    // 舞台尺寸由外部（onResize）注入，网格数随之变化
    this.stageW = 0;
    this.stageH = 0;
    this.rows = 0;
    this.cols = 0;

    this.regens = 0; // 当前轮因不连通已重造的次数

    // 首轮全联通开关：由组件侧注入（ALL_CONN），仅第一局生效
    this.firstFullConn = false;
  }

  // 舞台尺寸变化：重算行列数并重启当前轮
  resize(w, h, iInter) {
    this.stageW = w;
    this.stageH = h;
    // 垂直方向预留 80px：ThreeLayout 的全屏按钮悬浮在左下角
    // （bottom:14px + 高 36px = 占 50px），网格必须让出这片区域，
    // 否则起点（左下）会被按钮盖住；80 = 50px 按钮 + 两侧呼吸位
    this.rows = ((h - 80) / this.d) >> 0;
    this.cols = ((w - 50) / this.d) >> 0;
    if (this.rows < 2 || this.cols < 2) return; // 舞台过小不布网
    this.init(iInter);
  }

  init(iInter) {
    var i;
    // ---- 本轮状态全部复位（resize / 4s 重启都会整轮重来）----
    var palette = this.PALETTES[iInter & 1]; // iInter&1 交替两套底色
    this.colorDefault = palette.base;
    this.colorOpenSet = palette.open;
    this.colorClosedSet = palette.closed;
    this.colorSPT = palette.path;
    this.adj = []; // 邻接表：adj[v].neighbor = 与 v 相邻的顶点下标

    this.cameFrom = []; // 路径前缀：cameFrom[v] = 松弛时 v 的来源顶点
    this.result = []; // 最短路径（顶点序列，success 时回溯一次）
    this.s = 0; // 起点下标（网格左下角）
    this.closedSet = []; // 已定案顶点
    this.openSet = []; // 已发现、待处理顶点
    this.gScore = []; // g(v)：起点到 v 的实际代价
    this.fScore = []; // f(v) = g(v) + h(v)：经 v 到终点的估计代价
    this.V = this.rows * this.cols; // 顶点数
    this.E = 0; // 边数（文末统计，仅展示用）

    this.complete = false;
    this.n = -1;
    this.currentStep = -1;
    this.restartPending = false; // 复位：防 resize 打断后完成态无法再排重启
    //====================================
    // 重设 canvas 尺寸（顺带清空画布）
    this.eleCanvas.width = this.stageW;
    this.eleCanvas.height = this.stageH;

    // 离屏分层渲染：边层（每轮静态画一次）+ 顶点层（按状态增量画）。
    // 全联通网格 E≈4V、V 数千，逐帧全量重绘（O(V+E) 次描边 + 旧版
    // includes 的 O(V²) 集合扫描）会明显掉帧；分层后每帧只是两次
    // drawImage 合成 + 底部文字，成本近乎常数
    this.state = new Array(this.V).fill(0); // 0未涉足 1开放集 2关闭集 3路径
    this.edgeLayer = document.createElement('canvas');
    this.edgeLayer.width = this.stageW;
    this.edgeLayer.height = this.stageH;
    this.lctxE = this.edgeLayer.getContext('2d');
    this.lctxE.translate(25.5, 20.5); // 与主画布同一坐标原点
    this.vertexLayer = document.createElement('canvas');
    this.vertexLayer.width = this.stageW;
    this.vertexLayer.height = this.stageH;
    this.lctxV = this.vertexLayer.getContext('2d');
    this.lctxV.translate(25.5, 20.5);

    // 布网方式：首轮且开关开启 → 全联通网格（8 邻全连），帮助理解
    // 「理想路网」下的搜索扩散形态；之后各轮随机抽边
    if (this.firstFullConn) {
      this.initAdjFull();
    } else {
      this.initAdj();
    }
    this.openSet.push(this.s);

    // 无向图：addNeighbor/initAdjFull 的边记录需对称，doubleNeighbor 补齐
    this.doubleNeighbor();

    // 连通性守卫：随机路网可能起点到不了终点（openSet 耗尽走 fail），
    // 这类局演示价值为零——BFS 从起点出发，够不着终点就整网重造，
    // 上限兜底防极端情况卡死（真到上限也只会偶尔放行一局无解路网）
    if (!this.isConnected()) {
      if (++this.regens < 30) return this.init(iInter);
    }
    this.regens = 0;

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
  // 随机抽邻：8 邻中每个以 rate 概率入选（有向边，方向性由 doubleNeighbor 消除）
  addNeighbor(i, j) {
    var f = this;
    var arrDerection = f.findAllNeighbor(i, j).filter(function () {
      return Math.random() < f.rate;
    });

    return arrDerection;
  }

  // 主循环单步（组件 raf 每帧调一次）：推进一步搜寻 + 整帧重绘
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
      // 完成：走一次 success（排 4s 重启定时），此后 restartPending 挡住
      // 后续帧重复触发——画面冻结在完整路径上直到新一轮 init
      f.restartPending = true;
      f.success();
    }
    f.draw();
    return f;
  }
  // 完成回调：回溯路径 + 在顶点层描出 3px 黄色路径线 + 排重启定时
  success() {
    var f = this;
    f.findPath();
    // 黄线=最短路径：路径顶点已随关闭集渐次刷黄，这里补描 3px 路径边
    //（对应旧版逐帧 drawEdge 的路径高亮，只画这一次）
    f.lctxV.lineWidth = f.SPTw;
    f.lctxV.strokeStyle = f.colorSPT;
    for (var i = 0; i < f.result.length - 1; i++) {
      var a = f.index2center(f.result[i]);
      var b = f.index2center(f.result[i + 1]);
      f.lctxV.beginPath();
      f.lctxV.moveTo(a.x, a.y);
      f.lctxV.lineTo(b.x, b.y);
      f.lctxV.closePath();
      f.lctxV.stroke();
    }
    f.lctxV.lineWidth = 1;
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
  // 单步搜寻的入口（原作逐帧钩子的保留命名）
  doINeveryframe() {
    var f = this;
    f.watchOpenSet();
    return f;
  }
  // A* 核心一步：取 openSet 中 fScore 最小者 → 移入 closedSet → 松弛邻居。
  // 集合成员判定走 state 数组（O(1)），替代旧版 openSet/closedSet
  // includes 的线性扫描（O(V)×每邻居 = 全联通时 O(V²)/帧 的卡顿主因之一）
  watchOpenSet() {
    if (!this.openSet.length) {
      // 理论兜底：init 已保证连通，走到这里说明 regens 上限放行了无解局
      this.complete = true;
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
    // 关闭集 = 黄色势力范围：定案即刷黄（与旧版逐帧重绘的视觉效果一致）
    f.state[current] = 2;
    f.paintVertex(f.lctxV, current, f.colorClosedSet);

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

      // 到达终点：终点出 openSet 定案即为完成（回溯推迟到 success 统一做）
      if (neighbor === f.V - 1) {
        this.complete = true;
        return true;
      }
    }

    return f;
  }

  // 整帧合成：边层 + 顶点层两张离屏画布 drawImage 到主画布，
  // 再叠底部统计文字与起终点标记。每帧成本近乎常数（与 V/E 无关）
  draw() {
    var f = this;
    f.ctx.clearRect(0, 0, f.stageW, f.stageH);
    f.ctx.drawImage(f.edgeLayer, 0, 0);
    f.ctx.drawImage(f.vertexLayer, 0, 0);
    f.drawTextAndStartEnd();
    return f;
  }
  // 每轮一次：把整张路网（边 + 顶点）画到边层/顶点层离屏画布上。
  // 边层全程不变；顶点层之后只做增量更新（watchOpenSet / success）
  bakeLayers() {
    var f = this,
      i;
    f.lctxE.clearRect(-25.5, -20.5, f.stageW, f.stageH);
    f.lctxV.clearRect(-25.5, -20.5, f.stageW, f.stageH);
    f.lctxE.fillStyle = f.colorDefault;
    f.lctxE.strokeStyle = f.colorDefault;
    f.lctxE.lineWidth = 1;

    for (i = 0; i < f.adj.length; i++) {
      f.drawEdgeOn(f.lctxE, i);
    }
    for (i = 0; i < f.adj.length; i++) {
      f.paintVertex(f.lctxV, i, f.colorDefault);
    }
    return f;
  }
  // 在指定上下文画单个顶点（离屏层专用；半径 SPTw-1 略小于路径线宽）
  paintVertex(ctx, index, color) {
    var f = this;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(
      f.index2center(index).x,
      f.index2center(index).y,
      f.SPTw - 1,
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
  // 底部统计文字（V/E + 第几轮 + 状态）与起终点 crimson 标记
  drawTextAndStartEnd() {
    var f = this;
    // 文字画在主画布坐标系（无 translate 偏移）；13px 与旧版一致
    f.ctx.font = '13px "Microsoft JhengHei"';
    f.ctx.fillStyle = f.colorClosedSet;
    var strVE = `顶点数V: ${f.V}, 边数E: ${f.E}`;
    if (f.complete) {
      strVE += '(' + f.iInter + ')===> complete';
    } else {
      // loading 点动画：draw 每帧重绘，帧计数驱动点数 0→1→2→3 循环，
      // n>>3 每 8 帧变一次（约 133ms @60fps）
      var dots = '.'.repeat((f.n >> 3) % 4);
      strVE += '(' + f.iInter + ')===> 搜寻中' + dots;
    }
    // 文字落在下边 60px 按钮避让区内、网格底边下方（画布实际坐标）
    f.ctx.fillText(strVE, f.stageW / 2 - 2e2, f.stageH - 19.5);

    // 起终点红点：终点 V-1（右上）与起点 0（左下）。
    // index2center 返回网格坐标系（带 translate(25.5,20.5) 偏移），
    // 主画布无偏移，这里手动加上
    f.ctx.fillStyle = 'crimson';
    f.ctx.arc(
      f.index2center(f.V - 1).x + 25.5,
      f.index2center(f.V - 1).y + 20.5,
      5,
      0,
      2 * Math.PI,
      true,
    );
    f.ctx.closePath();
    f.ctx.arc(
      f.index2center(0).x + 25.5,
      f.index2center(0).y + 20.5,
      5,
      0,
      2 * Math.PI,
      true,
    );
    f.ctx.closePath();
    f.ctx.fill();

    return f;
  }
} // class

/* ---- 组件侧：实例持有 + raf 驱动 + 4s 重启定时管理 ---- */
// 演示开关：true = 首轮（第一次布网）生成全联通网格（每点与 8 邻全连），
// 直观展示「理想路网下 A* 的搜索范围」；后续轮恢复随机抽边。
// 改 false 关闭此额外功能，首轮即随机路网
const ALL_CONN = true;
let astar = null;
let restartTimer = null;
let iInter = 0; // 轮次计数：iInter&1 交替两套网格底色

function loop() {
  rafId = requestAnimationFrame(loop);
  if (disposed || !astar) return;
  astar.step();
}

// 舞台尺寸变化（ResizeObserver → stage-resize，含文案收展/窗口缩放/
// 全屏切换）：首进场创建实例并注入重启回调，此后每次交给 resize 布网
function onResize() {
  if (!canvasEl || disposed) return;
  const container = layoutRef.value?.stageRef;
  if (!container) return;
  const rect = container.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  if (!astar) {
    astar = new Astar(canvasEl);
    astar.iInter = iInter;
    // 首轮全联通网格（额外演示功能，ALL_CONN 开关）：帮观者先看到
    // 理想路网下的完整搜索形态；首轮走完即关闭，后续轮恢复随机路网
    if (ALL_CONN) astar.firstFullConn = true;
    // 原作 success() 直接重开新一轮（页面级脚本无卸载概念）；移植版把
    // 重启定时挪到组件侧：完成 → 4s 后换底色重开，卸载时可 clearTimeout
    // 拦截，防止离屏后仍定时重开
    astar.onRestart = function () {
      iInter++;
      this.iInter = iInter;
      this.firstFullConn = false; // 首轮演示结束，恢复随机布网
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (disposed || !astar) return;
        astar.restartPending = false;
        astar.init(iInter);
      }, 4e3);
    };
  }
  astar.resize(Math.round(rect.width), Math.round(rect.height), iInter);
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
  background: #000;
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
