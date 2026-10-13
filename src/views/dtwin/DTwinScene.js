/**
 * 车间设备监控 · three.js 场景层
 *
 * 只关心 canvas 绘制：500 台 InstancedMesh、拾取、相机飞行、呼吸动画、
 * 楼层 buffer 原地改写、dispose。对 Vue 一无所知——需要通知 UI 的时机
 * （选中/取消选中/渲染指标）通过 hooks 回调抛出去，需要读的数据
 * （选中设备快照）通过方法暴露。
 *
 * 硬性纪律：这里不 import vue，不碰 reactive/ref；
 * three 对象全部是普通变量，绝不能进 Proxy。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
// tween.js：three.js 生态事实上的伴生补间库（MIT、零依赖）。
// 它不带自己的动画循环 —— group.update() 挂进宿主 rAF（见 loop）
import { Group, Tween, Easing } from '@tweenjs/tween.js';
import Stats from 'stats.js';
// 着色器源码抽离到独立 .vert/.frag 文件（项目统一放 src/shaders/ 下），
// ?raw 由 Vite 内置支持：编译期把文件内容作为字符串内联，零运行时开销
import deviceVert from '@/shaders/device.vert?raw';
import deviceFrag from '@/shaders/device.frag?raw';

/* ===================== 场景规模常量 ===================== */
const COLS = 25;
const ROWS = 20;
const CAPACITY = COLS * ROWS; // InstancedMesh 按最大容量 500 建，每层实画 FLOOR_COUNTS[idx] 台
const FLOOR_COUNTS = [440, 469, 480]; // 每层设备数
const GAP = 2.3; // 设备间距（米）
export const FLOORS = ['1F', '2F', '3F'];

// 每层地板色：切换楼层时地面颜色随之变化，强化「换了车间」的感知
const FLOOR_COLORS = ['#36340b', '#360b0d', '#0b0d36'];

// 设备状态：0 运行 / 1 告警 / 2 停机
const STATUS_COLORS = [
  new THREE.Color('#3fae6a'),
  new THREE.Color('#e2483d'),
  new THREE.Color('#9aa0a6'),
];

/* ===================== 工厂函数 ===================== */
export function createWorkshopScene(container, hooks = {}) {
  /* ---------- three 对象（非响应式） ---------- */
  let renderer = null;
  let scene = null;
  let camera = null;
  let controls = null;
  let stats = null;
  let mesh = null; // 承载全部设备的 InstancedMesh（容量 500，每层实画 FLOOR_COUNTS 台）
  let deviceMaterial = null;
  let floorMaterial = null; // 地面材质：切层时改 color
  let edgesMesh = null; // 选中高亮描边（单个 LineSegments，额外仅 1 drawcall）
  let clock = null; // THREE.Timer：r185+ 官方推荐的时间源
  let raycaster = null;
  const ndc = new THREE.Vector2();
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  let machineHeight = 1.7; // 几何体包围盒高度，描边框定位用

  let rafId = 0;
  let disposed = false;
  let lastMetricsAt = 0;
  // 初始机位（单一事实来源）：init 里摆相机用，切楼后相机直接回位也用它
  const HOME_POS = new THREE.Vector3(0, 46, 30);
  const HOME_TARGET = new THREE.Vector3(0, 0, 0);
  // 每场景独立的 tween Group：不用库的 mainGroup 全局组，
  // 避免与其它页面实例串台；dispose 时整组 stop 干净
  const tweenGroup = new Group();
  let flyTween = null; // 相机飞行补间（双击触发，用户拖动时 stop）
  let floorIdx = 0;

  // 设备业务数据：TypedArray 纯数组（按容量 500 建），与 three 对象一样不进响应式系统
  const devStatus = new Uint8Array(CAPACITY);
  const devTemp = new Float32Array(CAPACITY);
  const devRpm = new Float32Array(CAPACITY);
  const devVib = new Float32Array(CAPACITY);
  const devOut = new Float32Array(CAPACITY);

  /* ===================== 资产管线 =====================
   * 约定：用 gltf-transform 把免费模型压到 2MB 内再放进来
   *   npx gltf-transform optimize in.glb out.glb --compress draco --texture-compress ktx2
   * 压缩后放 /public/models/device.glb 即自动启用；文件不存在（404 → onError）
   * 用程序化几何兜底，页面永不白屏。
   * 贴图发灰关键点：glTF 里 sRGB 贴图 GLTFLoader 会自动标 SRGBColorSpace；
   * 自己 new 的 CanvasTexture/TextureLoader 贴图必须手动
   *   tex.colorSpace = THREE.SRGBColorSpace
   * 否则按线性数据采样，颜色整体发灰发暗。
   */
  function loadDeviceGeometry() {
    return new Promise((resolve) => {
      new GLTFLoader().load(
        `${import.meta.env.BASE_URL}models/device.glb`,
        (gltf) => {
          let found = null;
          gltf.scene.traverse((o) => {
            if (!found && o.isMesh) found = o;
          });
          if (!found) return resolve(buildDeviceGeometry());
          const g = found.geometry.clone();
          found.updateWorldMatrix(true, false);
          g.applyMatrix4(found.matrixWorld); // 把节点变换烘进顶点，InstancedMesh 只要一份干净几何
          g.computeBoundingBox();
          g.translate(0, -g.boundingBox.min.y, 0); // 底部落到 y=0
          resolve(g);
        },
        undefined,
        () => resolve(buildDeviceGeometry()),
      );
    });
  }

  // 程序化「机床」剪影：底座 + 立柱 + 顶罩合并成单个 BufferGeometry
  // 500 台 × 约 36 三角形，一个 InstancedMesh 一次画完
  function buildDeviceGeometry() {
    const base = new THREE.BoxGeometry(1.5, 0.35, 1.0).translate(0, 0.175, 0);
    const column = new THREE.BoxGeometry(0.7, 1.0, 0.7).translate(0, 0.85, 0);
    const head = new THREE.BoxGeometry(1.1, 0.35, 0.85).translate(0, 1.525, 0);
    return BufferGeometryUtils.mergeGeometries([base, column, head]);
  }

  /* ===================== 初始化 ===================== */
  async function init() {
    if (!container || disposed) return;

    const geometry = await loadDeviceGeometry();
    if (disposed) {
      geometry.dispose(); // await 期间页面可能已卸载
      return;
    }
    geometry.computeBoundingBox();
    machineHeight = geometry.boundingBox.max.y;

    // —— 逐实例 attribute：随几何体走，一个 buffer 搞定全部容量 ——
    const aAlarm = new THREE.InstancedBufferAttribute(
      new Float32Array(CAPACITY),
      1,
    ); // 1=告警（itemSize=1 → 只许 setX）
    const aPhase = new THREE.InstancedBufferAttribute(
      new Float32Array(CAPACITY),
      1,
    );
    for (let i = 0; i < CAPACITY; i++) {
      aPhase.setX(i, Math.random() * Math.PI * 2); // 随机相位：呼吸错峰，不同步齐闪
    }
    geometry.setAttribute('aAlarm', aAlarm);
    geometry.setAttribute('aPhase', aPhase);

    // 相机：初始高高在上俯视车间地面
    camera = new THREE.PerspectiveCamera(
      55,
      container.clientWidth / container.clientHeight,
      0.1,
      300,
    );
    camera.position.copy(HOME_POS);

    scene = new THREE.Scene();
    scene.background = new THREE.Color('#eef1f4');

    // 灯光：设备材质是自绘光照不消费它；给将来 glb 的 PBR 材质留着
    scene.add(new THREE.AmbientLight('#ffffff', 0.8));
    const dir = new THREE.DirectionalLight('#ffffff', 1.2);
    dir.position.set(20, 40, 15);
    scene.add(dir);

    // 车间地面 + 网格（材质颜色在 regenerate 里随楼层更新）
    const floorGeo = new THREE.PlaneGeometry(84, 66).rotateX(-Math.PI / 2);
    floorMaterial = new THREE.MeshBasicMaterial({ color: FLOOR_COLORS[0] });
    scene.add(new THREE.Mesh(floorGeo, floorMaterial));
    const grid = new THREE.GridHelper(66, 30, 0x8a7f66, 0xdcd4c0);
    grid.position.y = -0.05;
    scene.add(grid);

    // —— 设备材质：自绘 Lambert 光照 + GPU 呼吸动画 ——
    deviceMaterial = new THREE.ShaderMaterial({
      uniforms: {
        /**
         * uTime：CPU 侧定义 uniform。JS 改 `.value`，
         * 渲染时 three 自动上传到着色器的 `uniform float uTime`。
         * （声明见此，累积见 init 里 new THREE.Timer()，消费见 loop）
         */
        uTime: { value: 0 },
        uLightDir: { value: new THREE.Vector3(0.5, 1, 0.35).normalize() },
      },
      vertexShader: deviceVert,
      fragmentShader: deviceFrag,
    });

    // —— 全部设备，一个 InstancedMesh，1 个 drawcall ——
    // 按容量 500 建实例 buffer；每层实画台数由 regenerate 里 mesh.count 控制
    mesh = new THREE.InstancedMesh(geometry, deviceMaterial, CAPACITY);
    // 视锥剔除：r158+ InstancedMesh 会聚合全部实例矩阵算包围球，整批剔除；
    // 注意剔除粒度是「整批」——单个实例级别要剔除得拆多 mesh 或自己写判定
    mesh.frustumCulled = true;
    scene.add(mesh);

    // 选中描边：EdgesGeometry 线框，比 OutlinePass 后处理便宜得多
    const eg = new THREE.BoxGeometry(
      1.5 + 0.16,
      machineHeight + 0.16,
      1.0 + 0.16,
    );
    edgesMesh = new THREE.LineSegments(
      new THREE.EdgesGeometry(eg),
      new THREE.LineBasicMaterial({ color: '#ffb020' }),
    );
    eg.dispose();
    edgesMesh.visible = false;
    scene.add(edgesMesh);

    // 渲染器
    renderer = new THREE.WebGLRenderer({ antialias: true });
    // 像素比封顶 2：4K 屏 devicePixelRatio 3 时全屏片元数翻倍，纯浪费
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // r152+ 默认已是 sRGB 输出，显式写出防呆（配合着色器里的 colorspace_fragment）
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    // 轨道控制器
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.copy(HOME_TARGET);
    controls.maxPolarAngle = 1.45; // 别转到地面以下
    controls.minDistance = 4;
    controls.maxDistance = 120;
    // 用户手动拖动时终止相机飞行动画，避免和人抢相机
    controls.addEventListener('start', onControlsStart);

    // stats.js：右下角 FPS 面板
    stats = new Stats();
    stats.showPanel(0);
    stats.dom.style.position = 'absolute';
    stats.dom.style.left = 'auto';
    stats.dom.style.right = '0';
    stats.dom.style.top = 'auto';
    stats.dom.style.bottom = '0';
    container.appendChild(stats.dom);

    raycaster = new THREE.Raycaster();
    clock = new THREE.Timer();

    // 交互事件：点击选中（区分拖拽）、双击飞过去
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('dblclick', onDblClick);
    window.addEventListener('resize', onResize);
    // 舞台尺寸变化的另一来源（txt 收起/展开的布局变化）由 ThreeLayout 的
    // ResizeObserver 感知，页面通过返回接口的 onStageResize() 转发进来

    regenerate(0);
    onResize();
    loop();
  }

  /* ===================== 楼层数据生成 / 切换 ===================== */
  // 可复现伪随机：同一层每次进来布局一致，不然切换楼层像洗牌
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 生成一层的 GPU 侧状态：矩阵 / 颜色 / 告警标记
  // 关键：复用同一份 instance buffer 原地改写，不 new 不 dispose —— 切楼零分配
  // 布局：25×20 网格，每行随机缺失 0~5 个位置（可复现伪随机，切楼来回布局一致）；
  // mesh.count = 本层实际台数，GPU 只画这些实例，容量 buffer 其余部分不参与渲染
  function regenerate(idx) {
    const rand = mulberry32(1000 + idx * 77);
    const count = FLOOR_COUNTS[idx];
    // 总缺口 = 容量 - 本层台数，需精确分配到 20 行，且每行缺 0~5
    let remaining = CAPACITY - count;
    let i = 0; // 实例写入游标
    for (let row = 0; row < ROWS; row++) {
      // 本行可缺范围：上限受「每行最多 5」和「剩余总量」约束；
      // 下限保证后面剩下的行还有容量接盘（5/行）
      const maxMiss = Math.min(5, remaining);
      const minMiss = Math.max(0, remaining - 5 * (ROWS - 1 - row));
      const missing = minMiss + ((rand() * (maxMiss - minMiss + 1)) | 0);
      remaining -= missing;
      const present = COLS - missing;
      // 在 25 个槽位里挑 present 个位置：缺失位置随机打散，而不是全堆行尾
      const slots = Array.from({ length: COLS }, (_, c) => c);
      for (let m = COLS - 1; m > 0; m--) {
        const j = (rand() * (m + 1)) | 0;
        [slots[m], slots[j]] = [slots[j], slots[m]]; // Fisher–Yates 洗牌
      }
      const kept = slots.slice(0, present).sort((a, b) => a - b); // 保留的列号，升序摆放
      for (const col of kept) {
        position.set(
          (col - (COLS - 1) / 2) * GAP,
          0,
          (row - (ROWS - 1) / 2) * GAP,
        );
        quaternion.identity();
        scale.set(1, 1, 1);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(i, matrix);

        const r = rand();
        // 状态分布（r ∈ [0,1) 均匀随机，用区间宽度控制占比）：
        //   [0, 0.045)  → 1 告警（约 4.5%）
        //   [0.045, 0.075) → 2 停机（约 3%）
        //   [0.075, 1)  → 0 运行（其余约 92.5%）
        const status = r < 0.045 ? 1 : r < 0.075 ? 2 : 0;
        devStatus[i] = status;
        mesh.setColorAt(i, STATUS_COLORS[status]);
        mesh.geometry.getAttribute('aAlarm').setX(i, status === 1 ? 1 : 0);
        i++;
      }
    }
    if (i !== count)
      console.warn(`regenerate: 写入 ${i} 台 ≠ 预期 ${count} 台`); // 布局参数改动时的防呆
    mesh.count = count; // 实画台数（< 容量 500），其余 buffer 区间不渲染
    // 改完 buffer 必须手动置脏，CPU → GPU 才会重新上传
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.geometry.getAttribute('aAlarm').needsUpdate = true;
    // 矩阵变了包围球要重算，否则视锥剔除拿旧球误判（切楼后设备"消失"多半是这）
    mesh.computeBoundingSphere();

    // 地板颜色随楼层切换（零分配：只改已有材质的 color）
    floorMaterial.color.set(FLOOR_COLORS[idx]);

    // 业务数据（CPU 侧，面板显示用）与 mesh 状态分开生成
    resetDeviceData(idx);
  }

  // 填充一层的业务初值（温度/转速/振动/产量），按容量 500 建、切层时全量重写
  // 与 regenerate 用不同的种子流：布局流和数据流互不干扰，
  // 改布局不会牵动数据，反之亦然。依赖 devStatus（regenerate 先跑）
  function resetDeviceData(idx) {
    const rand = mulberry32(9000 + idx * 77);
    for (let i = 0; i < CAPACITY; i++) {
      const status = devStatus[i];
      // 初值按状态落入合理区间，面板数据与设备外观互相印证：
      devTemp[i] = status === 1 ? 68 + rand() * 20 : 36 + rand() * 16; // 告警过热 68~88°C / 正常 36~52°C
      devRpm[i] = status === 2 ? 0 : 1400 + rand() * 1400; // 停机为 0 / 运行 1400~2800 rpm
      devVib[i] = status === 1 ? 6 + rand() * 5 : 0.5 + rand() * 2.5; // 告警 6~11 / 正常 0.5~3 mm/s
      devOut[i] = (rand() * 800) | 0; // 日产量 0~800 件，|0 截断取整
    }
  }

  function switchFloor(idx) {
    if (disposed || idx === floorIdx) return;
    floorIdx = idx;
    deselect(); // 换层后实例引用变了，旧选中作废（触发 onDeselect → UI 收面板）
    if (flyTween) {
      flyTween.stop();
      flyTween = null;
    }
    regenerate(idx);
    // 换层 = 换了个新车间：相机瞬间回到初始俯瞰位，不做飞行动画——
    // 平滑过渡会让用户误以为还是原来那个车间
    camera.position.copy(HOME_POS);
    controls.target.copy(HOME_TARGET);
    controls.update();
  }

  /* ===================== 拾取与选中 ===================== */
  let selectedId = -1;
  const downPx = { x: 0, y: 0 };
  let downAt = 0;

  function onPointerDown(e) {
    downPx.x = e.clientX;
    downPx.y = e.clientY;
    downAt = performance.now();
  }

  function onPointerUp(e) {
    // 拖拽视角不算点击：位移 > 6px 或按压 > 400ms 直接忽略
    const moved = Math.hypot(e.clientX - downPx.x, e.clientY - downPx.y);
    if (moved > 6 || performance.now() - downAt > 400) return;
    const id = pickAt(e.clientX, e.clientY);
    if (id >= 0) select(id);
    else deselect();
  }

  function onDblClick(e) {
    const id = pickAt(e.clientX, e.clientY);
    if (id >= 0) {
      select(id);
      flyToInstance(id);
    }
  }

  function pickAt(px, py) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(
      ((px - rect.left) / rect.width) * 2 - 1,
      -((py - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    // InstancedMesh 的射线求交会逐实例测并返回 instanceId，一次点击算一次，开销可控
    const hits = raycaster.intersectObject(mesh);
    return hits.length ? hits[0].instanceId : -1;
  }

  function select(i) {
    selectedId = i;
    mesh.getMatrixAt(i, matrix);
    matrix.decompose(position, quaternion, scale);
    edgesMesh.position.set(position.x, machineHeight / 2, position.z);
    edgesMesh.visible = true;
    // → UI 层：把选中快照抛给面板
    hooks.onSelect?.(snapshotForPanel(i));
  }

  function deselect() {
    selectedId = -1;
    if (edgesMesh) edgesMesh.visible = false;
    hooks.onDeselect?.();
  }

  /* ===================== 面板数据（mock WebSocket） ===================== */
  // 组装 UI 层面板需要的纯对象快照（primitive，可直接进 reactive）
  function snapshotForPanel(i) {
    const id = String(i + 1).padStart(3, '0');
    return {
      id: `${FLOORS[floorIdx]}-M${id}`,
      status: devStatus[i],
      temp: devTemp[i].toFixed(1),
      rpm: Math.round(devRpm[i]),
      vib: devVib[i].toFixed(2),
      out: Math.round(devOut[i]),
    };
  }

  // UI 层每秒轮询一次：只 tick 被选中的那台（500 台全量抖动毫无意义）
  // 返回该台最新快照；无选中返回 null
  function pollSelected() {
    if (disposed || selectedId === -1) return null;
    const i = selectedId;
    if (devStatus[i] !== 2) {
      devTemp[i] = Math.min(
        120,
        Math.max(20, devTemp[i] + (Math.random() - 0.5) * 1.2),
      );
      devRpm[i] = Math.min(
        3000,
        Math.max(1200, devRpm[i] + (Math.random() - 0.5) * 60),
      );
      devVib[i] = Math.min(
        15,
        Math.max(0.2, devVib[i] + (Math.random() - 0.5) * 0.4),
      );
      devOut[i] += (Math.random() * 4) | 0;
    }
    return snapshotForPanel(i);
  }

  /* ===================== 相机飞行（双击聚焦）· tween.js 版 =====================
   * 只补间一个进度对象 { k: 0→1 }（数值插值），相机/target 的 lerp 仍由我们做
   * —— tween.js 不会插值 Vector3，对进度标量补间是最简集成方式
   */
  function flyToInstance(i) {
    if (flyTween) flyTween.stop(); // 连续双击：上一次飞行立刻终止，从当前位置重新起飞
    mesh.getMatrixAt(i, matrix);
    matrix.decompose(position, quaternion, scale);
    // 保持当前观察方向，只是把距离收近：
    // target = 设备头部，pos = 设备 + 当前视线方向 × 9
    const dir = camera.position
      .clone()
      .sub(controls.target)
      .normalize()
      .multiplyScalar(9);
    const target = position.clone().add(new THREE.Vector3(0, machineHeight, 0));
    const progress = { k: 0 };
    const fromPos = camera.position.clone();
    const fromTarget = controls.target.clone();
    flyTween = new Tween(progress, tweenGroup)
      .to({ k: 1 }, 900)
      .easing(Easing.Cubic.InOut)
      .onUpdate(() => {
        camera.position.lerpVectors(
          fromPos,
          target.clone().add(dir),
          progress.k,
        );
        controls.target.lerpVectors(fromTarget, target, progress.k);
      })
      .onComplete(() => {
        flyTween = null;
      })
      .start();
  }

  function onControlsStart() {
    // 用户上手拖动，动画立刻让位（tween.js 的 stop 不会触发 onComplete）
    if (flyTween) {
      flyTween.stop();
      flyTween = null;
    }
  }

  /* ===================== 渲染循环 / 自适应 ===================== */
  function onResize() {
    if (!renderer) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return;
    renderer.setSize(rect.width, rect.height);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix(); // aspect 变了必须重算投影矩阵
  }

  function loop() {
    if (disposed) return;
    rafId = requestAnimationFrame(loop);
    stats.begin();
    tweenGroup.update(); // tween.js 不自带循环：挂进宿主 rAF 驱动所有补间
    controls.update(); // damping 开启后每帧必须调
    // 批量驱动的全部 CPU 开销就这一行：写一个 float uniform，500 台一起呼吸
    clock.update(); // Timer 需要显式 update 才推进时间
    // 取页面运行以来的总秒数写进 uTime.value —— 每帧仅此一次的 CPU→GPU 上传，
    // 500 台设备的呼吸差异全部在 GPU 里用 vPhase 各自错开
    deviceMaterial.uniforms.uTime.value = clock.getElapsed();
    renderer.render(scene, camera);
    stats.end();

    // 渲染指标 500ms 读一次即可；renderer.info 每帧读并上抛纯属浪费
    const now = performance.now();
    if (now - lastMetricsAt > 500) {
      lastMetricsAt = now;
      hooks.onMetrics?.(
        renderer.info.render.calls,
        renderer.info.render.triangles,
      );
    }
  }

  /* ===================== dispose 体系 =====================
   * 不做这套清理，HMR / 路由来回切后：页面挂多个 canvas、
   * WebGL 上下文与 GPU 显存持续增长（Chrome 任务面板可观测）。
   * 原则：rAF 停掉、监听摘掉、GPU 资源逐个 dispose、DOM 移除。
   */
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(rafId);
    tweenGroup.removeAll(); // 补间整组摘除（比逐个 stop 稳妥）

    window.removeEventListener('resize', onResize);
    if (renderer) {
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('dblclick', onDblClick);
    }
    if (controls) {
      controls.removeEventListener('start', onControlsStart);
      controls.dispose();
    }
    if (stats && stats.dom) stats.dom.remove();

    // 场景里的 GPU 资源逐个释放（几何体 + 材质；InstancedMesh 的 instance buffer 也随之释放）
    if (scene) {
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else if (m) m.dispose();
      });
    }
    deselect();
    if (renderer) {
      renderer.dispose();
      renderer.domElement.remove();
      renderer = null;
    }
    scene = null;
    camera = null;
    controls = null;
    mesh = null;
    deviceMaterial = null;
    floorMaterial = null;
    edgesMesh = null;
    raycaster = null;
  }

  init();

  // —— 对 UI 层暴露的最小接口 ——
  return {
    floorCount: FLOORS.length,
    switchFloor,
    onStageResize: onResize,
    pollSelected,
    dispose,
  };
}
