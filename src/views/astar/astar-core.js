/**
 * A* 搜寻算法演示核心（从 AStar.vue 抽离）：
 *   STYLE      —— 全部颜色/线宽/半径的唯一配置来源
 *   class Astar —— 一局的算法与绘制（布网/竞速/分层渲染/状态文字）
 * 组件侧（实例持有 / raf 驱动 / 面板与两阶段按钮）留在 AStar.vue，
 * 职责边界：生命周期与 UI 语义归组件，算法与渲染归本类。
 */

/* ---- 两阶段流程（对应面板「生成路网」「寻找最短路径」两按钮）----
 * 阶段一 布网：resize→init——建邻接表（含保解走廊、L 形隔墙）+ 烘焙
 *        静态图层，画面停在「路网就绪」；不初始化任何搜寻状态
 * 阶段二 搜寻：startSearch——初始化 A* 与 BFS 的起始状态，此后组件
 *        raf 逐帧调 step 推进，直到 complete（BFS 收官、A* 直接收官、
 *        两队列全空失败兜底）触发 success 定格
 * ---- 演示参数：由组件控件面板（滑动条/开关）注入 ----
 * rate     —— 无向边存在率 0.02(极稀)~1(全连通)，布网前注入（决定路网结构）
 * gridSize —— 网格单位长度 px（10~40），布网前注入
 * wantWall —— 是否布 L 形隔墙，布网前注入
 * waitBfs  —— A* 到终点后是否等 BFS 收官，寻路前注入（只影响搜寻行为） */

/* ---- 视觉配置（STYLE）：全部颜色/线宽/半径的唯一来源 ----
 * 三层视觉体系，按「信息重要性」从后往前：
 *   1. 背景层（LAYER_BG）    —— 静态路网：底边/顶点/隔墙，1px 网格色，全程不变
 *   2. 范围层（LAYER_RANGE） —— 已定格的搜索范围：半透明 α0.4，点线同色系，
 *                              整体「退后」，弱于算法主色（蓝/黄实心）
 *   3. 前景层（LAYER_LIVE）  —— 活跃信号：实时路径链 4px 实心，始终最抢眼
 * 调整任何颜色/粗细只改这个对象，各绘制函数只从这里读值 */
export const STYLE = {
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
  // 每局随机取一套配色。仅网格/文字底色（base）随局切换，
  // 算法语义色（open/closed）两套固定——开放集蓝/关闭集黄是「语言」，
  // 不随底色变；closed 亦作 A* 实时链与状态文字的颜色（实心主题黄）
  // base 用暗淡色（canvas 底 #141414 的微亮变体）：路网隐入暗夜只剩
  // 隐约纹理，算法活动的点与线成为黑暗中的光——「暗夜探路」的意境；
  // 两套明度接近、仅色相有别（冷青蓝 ⇄ 暖灰），换局时不产生跳变感
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

export class Astar {
  constructor(canvas) {
    this.eleCanvas = canvas;
    this.ctx = canvas.getContext('2d');

    // 起终点标记色：读全局色板 --color3（绿 #51cd85）。
    // canvas 上下文不认 CSS 变量，只能经 computed style 取值缓存
    this.colorEndPoints = getComputedStyle(document.documentElement)
      .getPropertyValue('--color3')
      .trim();

    this.d = 20; // 网格单位长度（px），组件布网前经 resize 注入

    this.n = -1; // raf 帧计数（驱动搜寻步进与 loading 点动画）
    this.interval = 1; // 每 N 帧搜一步（1 = 每帧一步）
    this.currentStep = -1; // 当前搜寻步数（n / interval）
    this.rate = 0.02; // 无向边存在率（面板滑动条 0.02~1，布网前注入）
    this.gridSize = 20; // 网格单位长度（面板滑动条，布网前注入）
    this.wantWall = false; // 是否布 L 形隔墙（面板勾选，布网前注入）
    this.waitBfs = false; // A* 到终点后是否等 BFS 收官（寻路前注入，只影响搜寻）
    this.ready = false; // init 未跑过（未开局）：step 直接跳过，防邻接表未建被访问
    this.searching = false; // 阶段旗标：false=就绪（路网已出、未搜寻）

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
  }

  // 舞台尺寸变化：重算行列数与网格原点，然后按当前面板参数重新布网。
  // isMobile：移动端下网格原点整体右移/下移，避让 App.vue 固定在
  // 左上角（12,12，44×44）的汉堡菜单按钮
  resize(w, h, isMobile) {
    this.stageW = w;
    this.stageH = h;
    this.isMobile = !!isMobile;
    this.d = this.gridSize || 20; // 网格单位长度（面板滑动条注入 10~40）
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
    this.init();
  }

  // 阶段一·布网（生成路网按钮 / resize）：只建路网与静态图层，
  // 不初始化搜寻状态——画面停在「路网就绪」，等用户点「寻找最短路径」。
  // 搜寻状态（A* 开放集/BFS 队列/代价表）全部在 startSearch 里初始化
  init() {
    var i;
    // ---- 本局状态全部复位 ----
    // 本局配色：底色按局随机轮换两套暗夜色板
    var palette = STYLE.PALETTES[Math.floor(Math.random() * 2)];
    this.colorDefault = palette.base;
    this.colorOpenSet = palette.open;
    this.colorClosedSet = palette.closed;
    this.adj = []; // 邻接表：adj[v].neighbor = 与 v 相邻的顶点下标

    this.cameFrom = []; // 路径前缀：cameFrom[v] = 松弛时 v 的来源顶点
    this.result = []; // 最短路径（顶点序列，success 时回溯一次）
    this.s = 0; // 起点下标（网格左下角）
    this.closedSet = []; // 已定案顶点
    this.openSet = []; // 已发现、待处理顶点（startSearch 时才入起点）
    this.gScore = []; // g(v)：起点到 v 的实际代价
    this.fScore = []; // f(v) = g(v) + h(v)：经 v 到终点的估计代价
    this.V = this.rows * this.cols; // 顶点数
    this.E = 0; // 边数（init 内统计，暂无展示出口，保留供调试）

    this.complete = false;
    this.searching = false; // 就绪态：路网已出、未搜寻
    this.n = -1;
    this.currentStep = -1;
    this.restartPending = false; // 复位：success 只走一次的挡帧旗标
    this.wallEdges = []; // 复位隔墙标记：非「翻墙局」不得残留上一局的墙线

    // BFS 对照组复位（队列初始化推迟到 startSearch，此处只清状态）
    this.bfsQueue = [];
    this.bfsState = new Array(this.V).fill(0);
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

    // 离屏分层渲染：边层（布网时静态画一次）+ 顶点层（按状态增量画）
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

    // 布网方式：rate 滑到 1 → 全联通网格（8 邻全连，无随机抽边）；
    // 其余档位随机抽边 + carveCorridor 走廊保解。
    // 极稀疏抽边下「起终点连通」纯靠运气，走廊织进路网后连通性由
    // 构造成立；稠密段走廊只是锦上添花，不影响观感
    if (this.rate >= 1) {
      this.initAdjFull();
    } else {
      this.initAdj();
      this.carveCorridor();
      // 走廊点记录为墙局禁区：极稀疏下走廊是唯一通路，随后的 buildWall
      // 若把臂点落在走廊上会把唯一解截断（无解局）。墙避开走廊即两机制
      // 正交——「保证有解」与「强制绕行」各管各的。
      // 禁区 = 走廊两端点（carveCorridor 逐边写入 corridorPairs，
      // 不能靠「从起点走邻接」重推——杂边会带偏、漏掉主链）
      this.corridorVerts = new Set();
      for (const [u, v] of this.corridorPairs) {
        this.corridorVerts.add(u).add(v);
      }
    }
    this.openSet = [];

    // 无向图：addNeighbor/initAdjFull 的边记录需对称，doubleNeighbor 补齐
    this.doubleNeighbor();

    // L 形隔墙：面板勾选时在布网阶段调用（墙点避开上方走廊禁区）
    if (this.wantWall) {
      this.buildWall();
    }

    // 统计边数（无向图邻接表度数之和 / 2）
    for (i = 0; i < this.V; i++) {
      this.E += this.adj[i].neighbor.length;
    }
    this.E = this.E / 2;

    // 路网定稿 → 烘焙静态图层（此后顶点层只做增量更新）
    this.bakeLayers();
    this.ready = true; // 布网完成：画面停在「路网就绪」，等 startSearch
  }
  // 阶段二·搜寻（寻找最短路径按钮）：初始化 A*/BFS 起始状态，
  // 此后 step 开始逐帧推进。就绪态或已完成态调用直接跳过——
  // 一局只寻一次，完成后画面定格，重开须先点「生成路网」
  startSearch() {
    if (!this.ready || this.searching || this.complete) return;
    var i;
    this.searching = true;
    this.n = -1;
    this.currentStep = -1;
    this.restartPending = false;

    // A* 起始：起点入开放集，g=0，其余 Infinity
    this.openSet = [this.s];
    this.closedSet = [];
    this.cameFrom = [];
    this.result = [];
    this.state.fill(0);
    for (i = 0; i < this.V; i++) {
      this.gScore[i] = Infinity;
      this.fScore[i] = Infinity;
    }
    this.gScore[this.s] = 0;
    this.fScore[this.s] = this.funHeuristic(this.s);

    // BFS 对照组起始：起点入队。bfsResult 必须显式清空——它是上一局
    // （可能等BFS=开）的残留，不清会让本局文案错误带出「BFS 路径」
    this.bfsQueue = [this.s];
    this.bfsState.fill(0);
    this.bfsState[this.s] = 1;
    this.bfsParent.fill(-1);
    this.bfsResult = [];
    this.bfsDone = false;
    this.astarDone = false;
    this.astarHead = -1;
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

  // 布网：按 rows×cols 逐行生成顶点，每顶点随机抽 8 邻
  //（addNeighbor 内按无向边存在率反解有向概率）
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
  // 先解后网：中点位移走廊（v3，替代旧「贪心随机游走」）。
  // 旧版只许走上/右两向，主链注定单调楼梯——后半程贴顶直线，观感假。
  // v3 用分形界的经典「中点位移法」（闪电/河流的程序化生成算法）直接
  // 生成解的几何形态：
  //   1. 起终点连线上递归中点随机垂直位移（位移幅 ∝ 段长 × 粗糙度，
  //      钳制在网格内部 ≥2 格——绝不贴边），得到一条自相似的蜿蜒控制
  //      折线：大尺度 sweeping 弯 + 小尺度抖动，曲折是算法的固有产出；
  //   2. 控制折线 DDA 光栅化成 8 邻格点序列，相邻点逐边织进邻接表
  //      （有向记录，doubleNeighbor 补无向）——连通性由构造保证；
  //   3. 折线可自交（走廊重合无害，邻接表去重），先下后上、先左后右
  //      随机出现，结构性回折；
  //   4. 求解与抽边密度正交——极稀疏（0.02）到稠密通用。corridorPairs
  //      同时是墙局禁区数据源（init 汇成 corridorVerts）。
  carveCorridor() {
    var f = this;
    var rough = 0.25 + Math.random() * 0.15; // 粗糙度：每局随机，蜿蜒幅度有局次差异

    // 1. 中点位移：起 (0,0) → 终 (cols-1, rows-1)，坐标 = [col, adjRow]
    //   （adjRow 0 = 画布底部，与渲染行翻转一致）。段长 ≤5 格停机，
    //   位移钳制在 [2, dim-3]——走廊永不贴边（贴顶直线是旧版顽疾）
    var ctrl = [];
    var sub = function (ax, ay, bx, by) {
      var dx = bx - ax;
      var dy = by - ay;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len <= 5) {
        ctrl.push([bx, by]);
        return;
      }
      var mx = (ax + bx) / 2;
      var my = (ay + by) / 2;
      var disp = (Math.random() - 0.5) * 2 * len * rough;
      mx += (-dy / len) * disp; // 垂直方向 (nx,ny) = (-dy,dx)/len
      my += (dx / len) * disp;
      mx = Math.min(f.cols - 3, Math.max(2, mx));
      my = Math.min(f.rows - 3, Math.max(2, my));
      sub(ax, ay, mx, my);
      sub(mx, my, bx, by);
    };
    sub(0, 0, f.cols - 1, f.rows - 1);

    // 2. 控制折线 → 8 邻格点序列（DDA 逐段插值取整，相邻重复点跳过）。
    //    逐段用「当前笔位」衔接（笔位起于 (0,0)）——若只对 ctrl[i-1]→ctrl[i]
    //    插值，(0,0)→ctrl[0] 的第一段会漏画：起点凭空跳接到 ctrl[0]
    //    （最长 5 格，即用户看到的 (0,0)-(1,2) 式非相邻长线）；
    //    步数 ceil：round 段长 1.4 取 1 会造成每步分量 >1 的跳格
    var seq = [[0, 0]];
    var last = seq[0];
    var px = 0;
    var py = 0; // 当前笔位（控制折线坐标，浮点）
    for (var i = 0; i < ctrl.length; i++) {
      var bx = ctrl[i][0];
      var by = ctrl[i][1];
      var steps = Math.max(
        1,
        Math.ceil(Math.max(Math.abs(bx - px), Math.abs(by - py))),
      );
      for (var t = 1; t <= steps; t++) {
        var x = Math.round(px + ((bx - px) * t) / steps);
        var y = Math.round(py + ((by - py) * t) / steps);
        if (x !== last[0] || y !== last[1]) {
          last = [x, y];
          seq.push(last);
        }
      }
      px = bx;
      py = by;
    }

    // 3. 格点序列 → 走廊边织进邻接表（s→end 方向有向记录）。
    //    兜底断言：相邻性被破坏（|Δ|>1 的跳格对）直接丢弃该边并告警，
    //    防止任何上游改动把「凭空长线」静默织进路网
    f.corridorPairs = [];
    for (i = 1; i < seq.length; i++) {
      var dr = Math.abs(seq[i][1] - seq[i - 1][1]);
      var dc = Math.abs(seq[i][0] - seq[i - 1][0]);
      if (dr > 1 || dc > 1) {
        console.warn('carveCorridor: 非相邻走廊边被丢弃', seq[i - 1], seq[i]);
        continue;
      }
      var u = f.ij2index(seq[i - 1][1], seq[i - 1][0]);
      var v = f.ij2index(seq[i][1], seq[i][0]);
      if (u < 0 || v < 0) continue; // 越界保护（位移已钳制，理论不触发）
      if (f.adj[u].neighbor.indexOf(v) < 0) f.adj[u].neighbor.push(v);
      f.corridorPairs.push([u, v]);
    }
    return f;
  }
  // 布网（全联通版）：每顶点与 8 邻全部连接，网格必然连通，
  // 用于「疏密」滑杆拉满（rate=1）时直观演示理想路网的搜索形态
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
  // L 形隔墙（面板「L障碍」勾选时布网阶段调用）：先正常出路网，
  // 再清除 L 形两臂上各点与邻居的所有联系——
  //   横臂：(r, c1)…(r, c2)  竖臂：(r2, c2)…(r, c2)（r2 < r）
  // 两臂共享拐角 (r, c2)，构成「┐」形：拐角在右上、凹口朝左下，
  // 正对左下起点的来路，最短路径必须绕到臂端缺口外再折回。
  // 臂点全部孤立后，8 邻网格里这条点带上下/左右都不可穿越（对角
  // 斜穿也无路可走——这正是只删臂内相邻边会漏的原因）。
  // 墙点避开走廊（corridorVerts）：极稀疏路网下走廊是唯一通路，
  // 臂点若落在走廊上会把唯一解截断成无解局。横竖比例随舞台宽高比自适应
  buildWall() {
    var f = this;
    // 网格过小（不足 6×8）时放不下像样的 L 形障碍，直接跳过
    if (f.rows < 6 || f.cols < 8) return f;
    var corridor = this.corridorVerts || new Set(); // 墙局禁区：走廊点集合

    // 障碍臂取位（行号大 = 画布上方）：拐角在全网格随机取，
    //   拐角行 r ∈ [1, rows-2]、拐角列 c2 ∈ [1, cols-2]（钳制非贴边行列，
    //   末行/末列仍不可落——贴边会让墙与画布边缘合围出死局）；
    //   横臂起点 c1：横臂向左延伸的长度随机（占 cols 的 ~2/3，±1/12 抖动），
    //     钳制 ≥1——臂端永不贴左缘
    //   竖臂终点 r2：竖臂向下延伸的长度随机（占 rows 的 ~2/3，±1/12 抖动），
    //     钳制 ≥1——臂端永不贴底缘
    // 取位优先避开走廊（重试 150 次 + 臂长收缩到 ≥1/4，见下）；重试
    // 耗尽则**直接放墙，允许无解**——用户勾了障碍就是要看障碍，BFS
    // 跑不到终点会走 fail 兜底结束本局，两链皆空本身也是「墙截断了
    // 唯一通路」的直观演示
    var ok = false;
    var r;
    var c2;
    var c1;
    var r2;
    var i;
    var j;
    for (var attempt = 0; attempt < 150 && !ok; attempt++) {
      // 臂长收缩系数：前 50 次全尺寸，之后线性缩到 1/4
      var shrink = attempt < 50 ? 1 : 1 - (0.75 * (attempt - 50)) / 100;
      var spanC = Math.max(
        4,
        Math.floor(
          (Math.floor(f.cols * 2 / 3) -
            Math.floor(Math.random() * Math.floor(f.cols / 12))) *
            shrink,
        ),
      );
      var spanR = Math.max(
        4,
        Math.floor(
          (Math.floor(f.rows * 2 / 3) -
            Math.floor(Math.random() * Math.floor(f.rows / 12))) *
            shrink,
        ),
      );
      r = 1 + Math.floor(Math.random() * (f.rows - 2)); // [1, rows-2]
      c2 = 1 + Math.floor(Math.random() * (f.cols - 2)); // [1, cols-2]
      c1 = Math.max(1, c2 - spanC);
      r2 = Math.max(1, r - spanR);
      // 收集两臂格点，检查是否撞走廊
      var probe = [];
      for (j = c1; j <= c2; j++) probe.push(f.ij2index(r, j));
      for (i = r2; i < r; i++) probe.push(f.ij2index(i, c2));
      ok = probe.every(function (idx) {
        return !corridor.has(idx);
      });
    }
    // ok=false = 重试耗尽：不避走廊，直接放墙（允许无解，见上注释）；
    // ok=true = 命中了避开走廊的干净位，用该位

    // 收集两臂的全部格点（含共享拐角，拐角只收一次）；
    // wallEdges 记录臂内相邻点对，仅供 bakeLayers 用网格色重描一遍
    var wallVerts = [];
    this.wallEdges = [];
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
  // 随机抽邻：8 邻中每个以有向概率 p 入选（方向性由 doubleNeighbor 消除）。
  // 面板的 rate 是「无向边存在率」s：一对邻居至少一侧被抽中的概率
  // 2p−p² = s ⇒ p = 1−√(1−s)。若直接把滑杆值当 p，无向边率 = 2p−p²
  // 后段饱和（0.5→0.75、0.8→0.96），滑杆过半后路网全是密密麻麻一个样
  addNeighbor(i, j) {
    var f = this;
    var p = 1 - Math.sqrt(1 - f.rate);
    var arrDerection = f.findAllNeighbor(i, j).filter(function () {
      return Math.random() < p;
    });

    return arrDerection;
  }

  // 主循环单步（组件 raf 每帧调一次）：推进一步竞速 + 整帧重绘。
  // 两阶段驱动：布网后 searching=false → 只重画「就绪」画面；
  // startSearch 后逐帧推进搜寻；complete 由 BFS 收官（bfsStep）或
  // 失败兜底（watchOpenSet）置位，success 只走一次（restartPending 挡帧）
  step() {
    var f = this;
    if (!f.ready) return f;
    f.n++;
    if (!f.searching) {
      // 就绪态：路网已出、未搜寻，drawLivePaths 对空链是零成本，
      // 每帧重画只为保持起终点标记与状态文字（首次进入由 init 烘焙）
      f.draw();
      return f;
    }
    if (!f.complete) {
      // 搜寻中：按 interval 节流步进（interval=1 即每帧一步）
      if (!(f.n % f.interval)) {
        f.currentStep = f.n / f.interval;
        f.doINeveryframe();
      }
    } else if (!f.restartPending) {
      // 完成：走一次 success（回溯路径 + 定格画面），此后 restartPending
      // 挡住后续帧重复触发——画面冻结，重开须用户点「生成路网」
      f.restartPending = true;
      f.success();
    }
    f.draw();
    return f;
  }
  // 完成回调：回溯 A* 路径 + 定格范围层与路径层 + 通知组件侧。
  // 补齐两处运行期永远没人画的视觉缺口：
  //   1. 黄-黄边靠「后定案者触发」，但终点永不进 closedSet（松弛到即
  //      结束），且链末端的定案顺序与链相邻顺序交错——离终点 1~2 跳
  //      的边运行期永远没人画；
  //   2. 链尾中间点只被「发现」（state===1 蓝点）未被「定案」，松弛到
  //      终点即停后永远停在蓝色。
  // 此处沿 result 回溯逐点刷黄、逐边补描，范围层定格成一条连续黄链
  success() {
    var f = this;
    f.findPath();
    f.bfsFlush(); // BFS 对照组收尾：剩余已发现点一次性染白定格
    f.lctxV.strokeStyle = STYLE.LAYER_RANGE.closedPoint;
    f.lctxV.lineWidth = STYLE.LAYER_RANGE.lineWidth;
    for (var i = 0; i < f.result.length; i++) {
      var v = f.result[i];
      f.paintVertex(f.lctxV, v, STYLE.LAYER_RANGE.closedPoint);
      if (i > 0) {
        var u = f.result[i - 1];
        f.lctxV.beginPath();
        f.lctxV.moveTo(f.index2center(u).x, f.index2center(u).y);
        f.lctxV.lineTo(f.index2center(v).x, f.index2center(v).y);
        f.lctxV.closePath();
        f.lctxV.stroke();
      }
    }
    // 路径层定格：complete 后 drawLivePaths 早退不再重画，路径层停住的
    // 正是「收官前一帧」的实时链画面。等BFS=开时它已是最终结果——
    // 白链头 = BFS 收官时的终点（队首即终点，回溯到起点），黄链头 =
    // 终点——两链天然完整，原样保留即是定格，无需任何重画；
    // 等BFS=关时上一帧黄链止于最后一个定案点（终点被「发现」但永不
    // 定案，缺终点前 2~3 跳）——清层重画：白链（BFS 被中止时的探测
    // 触手，队首→起点，标注「已中止」）先画、黄链（完整 A* 最短路）
    // 后画盖住重叠段，与运行期层级一致
    if (!f.bfsDone) {
      f.lctxP.setTransform(1, 0, 0, 1, 0, 0);
      f.lctxP.clearRect(0, 0, f.pathLayer.width, f.pathLayer.height);
      f.lctxP.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
      f.lctxP.translate(f.ox, f.oy);
      f.lctxP.lineWidth = STYLE.LAYER_LIVE.lineWidth;
      var drawChain = function (chain, color) {
        if (chain.length < 2) return;
        f.lctxP.strokeStyle = color;
        f.lctxP.beginPath();
        f.lctxP.moveTo(f.index2center(chain[0]).x, f.index2center(chain[0]).y);
        for (var k = 1; k < chain.length; k++) {
          f.lctxP.lineTo(f.index2center(chain[k]).x, f.index2center(chain[k]).y);
        }
        f.lctxP.stroke();
      };
      // 白链：BFS 中止时的探测触手（当前队首沿 bfsParent 回溯到起点）
      if (f.bfsQueue.length) {
        var b = f.bfsQueue[0];
        var whiteChain = [b];
        while (f.bfsParent[b] >= 0 && b !== f.s) {
          b = f.bfsParent[b];
          whiteChain.push(b);
        }
        drawChain(whiteChain, STYLE.LAYER_LIVE.bfsColor);
      }
      drawChain(f.result, f.colorClosedSet);
    }
    if (f.onComplete) f.onComplete();
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
  // A* 走一步，BFS 对照组同步走一步（各一步/帧，节奏对齐）。
  // waitBfs=false：A* 到终点（astarDone）后不再推 BFS，本局即刻结束——
  // 单算法演示模式，不跑对照
  doINeveryframe() {
    var f = this;
    f.watchOpenSet();
    if (f.waitBfs || !f.astarDone) f.bfsStep();
    else f.complete = true; // A* 已到终点且不等 BFS → 收官
    return f;
  }
  // A* 核心一步：取 openSet 中 fScore 最小者 → 移入 closedSet → 松弛邻居。
  // 集合成员判定走 state 数组（O(1)），替代旧版 openSet/closedSet
  // includes 的线性扫描（O(V)×每邻居 = 全联通时 O(V²)/帧 的卡顿主因之一）。
  // astarDone（A* 已到终点，等 BFS 收官）后不再扩张
  watchOpenSet() {
    if (this.astarDone) return false;
    if (!this.openSet.length) {
      // 理论兜底：init 已保证连通（carveCorridor 走廊），走到这里说明
      // 走廊被墙局破坏且侧边全断——补一个兜底：两队列全空即整轮失败结束
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
  // 底部状态文字（四态：路网就绪 / 搜寻中 / A* 已到终点等 BFS / 已完成）
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
      // 完成态附两算法路径长度（跳数：顶点数 −1，斜边与横竖边同为 1 单位）。
      // BFS 有完整最短路（bfsDone）→ 显示其长度；等BFS=关时 BFS 半途
      // 被中止，白链只是探测触手 → 标注「（已中止）」。bfsResult 在
      // startSearch 显式清空，不会残留上一局的信息
      var lenA = f.result.length ? f.result.length - 1 : 0;
      if (f.bfsDone && f.bfsResult.length) {
        label = '已完成，A* 路径 ' + lenA + '，BFS 路径 ' + (f.bfsResult.length - 1);
      } else if (f.bfsQueue.length) {
        // 中止时的白触手长度（队首沿 bfsParent 回溯到起点的跳数）
        var lenW = 0;
        var b = f.bfsQueue[0];
        while (f.bfsParent[b] >= 0 && b !== f.s) {
          b = f.bfsParent[b];
          lenW++;
        }
        label = '已完成，A* 路径 ' + lenA + '，BFS 路径 ' + lenW + '（已中止）';
      } else {
        label = '已完成，A* 路径 ' + lenA;
      }
    } else if (!f.searching) {
      // 阶段一就绪：路网已生成，画面静止等「寻找最短路径」
      label = '路网就绪';
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

    // 起终点标记：终点 V-1（右上）与起点 s（左下），--color3 绿色。
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
      f.index2center(f.s).x + f.ox,
      f.index2center(f.s).y + f.oy,
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
