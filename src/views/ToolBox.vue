<template>
  <ThreeLayout class="ToolBox__vue" ref="layoutRef" @stage-resize="onResize">
    <!-- https://www.tourboxtech.com/jp/tourbox-elite-natural-series/ -->
    <template #default>
      <h1 class="txt-title">TourBox</h1>
      <p class="txt-sub">
        <a
          class="tb-link"
          href="https://tourboxtech.com/en/"
          target="_blank"
          rel="noopener noreferrer"
          >TourBox</a
        >
        创意控制器——单手掌控剪辑/调色/绘画工作流的创意硬件。此处是它的数字样机：
        模型分两段加载——主角先行（独享带宽，就位即渲染），其余三个随后并发、全部就绪后依次插入右侧
        （单个失败静默跳过）；按包围盒归一缩放、底部对齐，主角居中。移动端仅载入主角。
      </p>
      <p class="txt-sub">
        左键点选零件——高亮变黄、折线标注从标签端拉出；
        14个键位逐个按压回弹，转盘/旋钮/滚轮以「人手操作」状态机自转——
        快转、慢调、偶尔反拨、时有停顿，正如「转着调色」的直觉手感。
        距离过远时相机自动飞近，落地后才演示动画。
      </p>
      <p class="txt-hint">
        <a
          class="tb-link"
          href="https://tourboxtech.com/en/"
          target="_blank"
          rel="noopener noreferrer"
          >TourBox</a
        >
        - 真正的创作工具，艺术家的最强武器
      </p>
    </template>

    <template #stage>
      <!-- 选中零件的名称标注：折线 + 标签（ref 拿舞台容器做屏幕投影） -->
      <div ref="labelLayerRef" class="label-layer">
        <svg v-show="label.visible" class="label-svg">
          <!-- 二段折线：斜线到肘点 → 水平线到标签（颜色统一走 CSS：--color2）。
               pathLength=1 归一化线长 + key 绑定选中序号：每次拾取重建元素，
               重放 dashoffset -1→0 的引出动画（标签端 → 零件端） -->
          <path
            :key="labelSeq"
            :d="`M ${label.fromX} ${label.fromY} L ${label.elbowX} ${label.elbowY} H ${label.endX}`"
            pathLength="1"
            stroke-width="1.5"
            fill="none"
          />
          <circle
            :key="`dot-${labelSeq}`"
            :cx="label.fromX"
            :cy="label.fromY"
            r="3"
          />
        </svg>
        <span
          v-show="label.visible"
          class="label-chip"
          :class="{ 'label-left': label.alignLeft }"
          :style="{ left: label.chipX + 'px', top: label.chipY + 'px' }"
          >{{ label.text }}</span
        >
      </div>

      <!-- 加载提示居中显示（移动端/桌面端一致）：一眼可见，又不用铺满遮罩 -->
      <div v-if="loading" class="loading">模型加载中…</div>
    </template>
  </ThreeLayout>
</template>

<script setup>
/* ToolBox 演示页：GLB 资产陈列 + 零件交互演示。
 * 资产管线：主角（mesh版）先串行独享带宽、就位即渲染，其余卫星随后并发加载、就绪后按序插入；
 * 布局：包围盒归一缩放 → 底部对齐 → 等间距排开，主角居中于原点；
 * 拾取：14 键位白名单，左键高亮 + 折线标注，右键对焦所属模型；
 * 旋转演示：转盘/旋钮/滚轮绕世界自然轴自转（pivot Group + attach 实现），
 *   角速度由「人手操作」状态机驱动（快转/慢转/细调/停顿/反拨）；
 * 漫游：球坐标驱动相机环绕（autoOrbit 默认关闭），用户操作时让位 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
// lil-gui：three 官方示例同款 GUI 控件（随 three 依赖分发，零额外安装）
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import ThreeLayout from '@/components/ThreeLayout.vue';
import PART_NAME_MAP from '@/assets/tourbox.txt?raw'; // mesh名 → 官方零件名

// public/tourbox 下的模型清单（中文文件名由 Vite 原样代理，无需编码处理）
const MODELS = [
  { file: 'tourbox_mesh.glb', label: 'mesh版' }, // 主角：零件未合并，可拾取（Draco 压缩 285KB / 原 3.16MB）
  { file: '白色.glb', label: '白色' }, // Draco 压缩后 441KB（原 3.68MB）
  { file: '蓝色.glb', label: '蓝色' }, // Draco 压缩后 441KB（原 3.68MB）
  { file: '黄色.glb', label: '黄色' }, // Draco 压缩后 441KB（原 3.68MB）
];

// 四个 glb 都是 Draco 压缩版：共享一个带解码器的 loader（每个 GLTFLoader 各配一个
// DRACOLoader 会重复起 worker）。主角虽然也是 Draco，但保留了独立的 mesh
// 节点（零件未合并），拾取逻辑无需改动。
// 解码器地址由 three 的 DRACOLoader 用 import.meta.url 内置，Vite 会随包发布，
// 无需 setDecoderPath，也不用往 public 里拷解码器文件
const dracoLoader = new DRACOLoader();
const gltfLoader = new GLTFLoader().setDRACOLoader(dracoLoader);

// 移动端（<768px）只载入主角：屏幕小放不下陈列排开，还省下 3 个 glb
// 的下载与渲染开销（断点与 ThreeLayout / README 的 768px 约定一致）
const isDesktop = window.matchMedia('(min-width: 768px)').matches;
const LOAD_LIST = isDesktop
  ? MODELS
  : MODELS.filter((m) => m.label === 'mesh版');

const layoutRef = ref(null);
const loading = ref(true);
/* 遮罩至少展示 300ms：本地缓存秒开时转圈一闪而过反而刺眼 */
const MIN_LOADING_MS = 300;
const loadStartAt = performance.now();
const labelLayerRef = ref(null);
// 标注层响应式状态：折线三顶点 + 标签位置/文字/对齐方向
const label = ref({
  visible: false,
  text: '',
  fromX: 0,
  fromY: 0,
  elbowX: 0,
  elbowY: 0,
  endX: 0,
  chipX: 0,
  chipY: 0,
  alignLeft: false,
});
// 选中序号：每完成一次新拾取自增，绑在 path/circle 的 key 上强制重建
// SVG 元素，从而重放「引线从标签端拉向零件」的 dash 动画
let labelSeq = 0;

let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let rafId = 0;
let disposed = false;
// 零件拾取：raycaster + 指针事件（pickEnabled 在模型就位后开启）
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pickEnabled = false;

// 解析零件对照表：'零件名-mesh名' → { mesh名: 零件名 }
const PARTS = Object.fromEntries(
  PART_NAME_MAP.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [label, meshName] = line.split('-');
      return [meshName, label];
    }),
);
const NAMED_PARTS = Object.keys(PARTS); // 14 个已知零件的 mesh 名

/* ===================== 初始化 ===================== */
function init() {
  const container = layoutRef.value?.stageRef;
  if (!container || disposed) return;

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true, // 透明底：WebGL 画布透明，透出容器上的 CSS 渐变背景
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene(); // 不设 background：透出容器 CSS 渐变棚纸

  // 照明：半球环境光 + 主平行光 + 冷补光 + 右后轮廓光（黑模型细节靠 rim light 撑起）
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 2.2));
  const sun = new THREE.DirectionalLight(0xfff2d6, 2.4);
  sun.position.set(3, 6, 4);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xbcd0ff, 0.9);
  fill.position.set(-4, 2, -3);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 4.6);
  rim.position.set(-2, 5, -6); // 右后方高位，勾出模型顶部/侧缘亮边
  scene.add(rim);

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  // 加载期间 loading 提示已覆盖注意力，原点相机渲染空场景合法，无需预设机位

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false; // 关闭惯性：拾取标注是静态投影，惯性滑行会让引线漂离零件
  controls.target.set(0, 0.8, 0);
  renderer.domElement.addEventListener('contextmenu', (e) =>
    e.preventDefault(),
  );

  // 地面网格：亮背景同步提亮（深灰网格线在浅底上是细腻的参考系）
  const grid = new THREE.GridHelper(20, 20, 0x9aa5b1, 0xc8cfd8);
  scene.add(grid);

  // 世界坐标轴指示器：红=X 绿=Y 蓝=Z（位于原点，验证方向用）
  const SHOW_AXES = false; // 调试开关：是否显示坐标轴
  if (SHOW_AXES) scene.add(new THREE.AxesHelper(5));

  loadModels();
  initMatGui(container); // 选中材质 GUI（拾取零件后自动展开）
  onResize();
  startLoop();
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
}

/* ===================== 加载并排布模型 ===================== */
// 非主角模型的反照率补偿系数：灯光为烘托黑色主角而偏强，高反照率的
// 彩色模型（尤其白色）会过曝到纯白。把它们的材质颜色整体调暗以还原
// 细节；主角（mesh版）材质零改动，保持既定观感
const SATELLITE_DIM = 0.44;
// 单个 glb → { model, width, label }；失败 resolve null（调用方静默跳过，不阻塞其余）
function loadOne(item) {
  return new Promise((resolve) => {
    gltfLoader.load(
      `${import.meta.env.BASE_URL}tourbox/${item.file}`,
      (gltf) => {
        if (disposed) return resolve(null);
        const model = gltf.scene;

        // 统一缩放：按包围盒最高维度归一（模型大小不一也能并排等高）
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        model.scale.setScalar(2.2 / maxDim);

        // 反照率补偿：仅非主角模型。遍历去重（glb 内多 mesh 常共享材质，
        // 需避免同一材质被反复乘暗）
        if (item.label !== 'mesh版') {
          const seen = new Set();
          model.traverse((o) => {
            if (!o.isMesh) return;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of mats) {
              if (!m?.color || seen.has(m)) continue;
              seen.add(m);
              m.color.multiplyScalar(SATELLITE_DIM);
            }
          });
        }

        // 缩放后重算包围盒：底部对齐 y=0（落地），量出缩放后宽度
        const scaledBox = new THREE.Box3().setFromObject(model);
        model.position.y = -scaledBox.min.y;
        const width = scaledBox.getSize(new THREE.Vector3()).x;

        resolve({ model, width, label: item.label });
      },
      undefined,
      () => resolve(null), // 404 等失败 → null 占位，其余模型照常排布
    );
  });
}

async function loadModels() {
  const root = new THREE.Group();
  scene.add(root);

  const GAP = 0.4;
  let cursor = 0; // 卫星排布游标：主角就位时初始化为「主角右缘 + GAP」

  const reveal = () => {
    loading.value = false;
    pickEnabled = true; // 模型就位，启用拾取
  };
  /* 遮罩至少展示 300ms：本地缓存秒开时转圈一闪而过反而刺眼 */
  const revealSoon = () => {
    const remain = MIN_LOADING_MS - (performance.now() - loadStartAt);
    if (remain > 0) setTimeout(reveal, remain);
    else reveal();
  };

  // 主角就位：X/Z 归零居中（底部已对齐 y=0）+ 相机取景 + 撤遮罩。
  // 取景只依赖主角包围盒——卫星后插入不移动主角与相机（无 reflow）
  function placeMain(b) {
    b.model.userData.gltfRoot = true; // 右键对焦时识别 glb 根的标记
    root.add(b.model);
    const box = new THREE.Box3().setFromObject(b.model);
    const center = box.getCenter(new THREE.Vector3());
    // 卫星游标必须基于「居中前」的主角右缘（原版 arrange 语义）：
    // 模型原点偏离几何中心时，居中会平移 −center.x，用居中后的 max.x
    // 会让整排卫星左移 center.x（白色模型从只露一角变成大半可见）
    const preMoveMaxX = box.max.x;
    b.model.position.x -= center.x;
    b.model.position.z -= center.z;
    const finalBox = new THREE.Box3().setFromObject(b.model);
    const c = finalBox.getCenter(new THREE.Vector3());
    const size = finalBox.getSize(new THREE.Vector3());
    const dist =
      (Math.max(size.x, size.y) / 2 / Math.tan((Math.PI / 180) * 22.5)) * 2.8;
    camera.position.set(c.x, c.y + size.y * 1.4, c.z + dist);
    controls.target.copy(c);
    controls.update();
    cursor = preMoveMaxX + GAP; // 卫星从主角右缘排开
    revealSoon();
  }

  // 卫星就位：追加在主角右侧队尾（主角与相机纹丝不动）
  function placeSatellite(b) {
    b.model.userData.gltfRoot = true;
    root.add(b.model);
    const bb = new THREE.Box3().setFromObject(b.model);
    const w = bb.getSize(new THREE.Vector3()).x;
    b.model.position.x += cursor - bb.min.x + 0.8;
    cursor += w + GAP;
  }

  /* 加载策略（混合）：主角先串行、独享带宽——首屏只等主角（3.16MB），
   * 若 4 个并发均分带宽，主角要等 ~89% 总流量才就位；
   * 主角就位后其余卫星并发下载，全部结束后按清单顺序依次插入。
   * 用 allSettled 而非逐项 then：三者等大、同时发出、带宽均分，
   * 完成时间本就几乎一致，等最慢的一个不损失观感，换来数组天然保序。
   * 主角降级语义：首项失败则继续串行尝试下一项，首个成功者顶替当主角 */
  let mainIndex = -1;
  for (let i = 0; i < LOAD_LIST.length; i++) {
    const b = await loadOne(LOAD_LIST[i]);
    if (disposed) return;
    if (b) {
      mainIndex = i;
      placeMain(b);
      break;
    }
  }

  // 全部失败：撤遮罩露出空场景（无拾取目标，开着无害）
  if (mainIndex < 0) {
    revealSoon();
    return;
  }

  // 其余卫星并发：loadOne 不会 reject（失败也 resolve(null)），故 fulfilled 才插入
  const rest = LOAD_LIST.slice(mainIndex + 1);
  const settled = await Promise.allSettled(rest.map(loadOne));
  if (disposed) return;
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value) placeSatellite(r.value);
  }
}

/* ===================== 拾取与选中 ===================== */
let pickedMesh = null; // 当前选中零件（左键：高亮 + 标注）

/* ---- 选中材质 GUI（lil-gui，three 官方示例同款控件） ----
 * 六个 PBR 参数：金属度 / 粗糙度 / 颜色 / 清漆 / 透射 / 透明度。清漆与透射是
 * MeshPhysicalMaterial 的扩展槽位——全局选中材质克隆时即升级为 Physical
 * 子类（copy 平移 Standard 参数，外观零变化）。dispose 时 destroy。
 * 注意 lil-gui addColor 认字符串/整数，THREE.Color 用 getHexString 桥接 */
let matGui = null; // lil-gui 实例
let matProxy = null; // GUI 绑定的代理对象 { 颜色hex, 各标量参数 }
const matControllers = []; // 需要随拾取换目标重灌的控制器
// GUI 行为回调：proxy 值写回全局选中材质。清漆/透射从 0 变非 0（或反之）
// 决定着色器是否编译 USE_CLEARCOAT / USE_TRANSMISSION 分支，跨界才置
// needsUpdate，其余参数是纯 uniform 直改即可
function applyMatProxy() {
  const m = globalSelMat;
  if (!m) return;
  const extBefore = m.clearcoat > 0 || m.transmission > 0;
  m.color.set(matProxy.颜色);
  m.metalness = matProxy.金属度;
  m.roughness = matProxy.粗糙度;
  m.clearcoat = matProxy.清漆;
  m.clearcoatRoughness = matProxy.粗糙度; // 清漆粗糙度跟随主粗糙度，少一个滑杆
  m.transmission = matProxy.透射;
  // 透明度：opacity < 1 必须开 transparent 才生效；回 1 时关掉，
  // 避免透明渲染队列的排序副作用残留在不透明模型上。transparent
  // 切换影响渲染队列归属与混合方程，保险起见同步 needsUpdate
  const wasTransparent = m.transparent;
  m.opacity = matProxy.透明度;
  m.transparent = matProxy.透明度 < 1;
  const extAfter = m.clearcoat > 0 || m.transmission > 0;
  if (extBefore !== extAfter || wasTransparent !== m.transparent)
    m.needsUpdate = true;
}

function initMatGui(container) {
  matGui = new GUI({
    title: '选中材质',
    container, // 挂进舞台：随舞台布局/全屏一起走
    width: 220,
  });
  matGui.domElement.classList.add('mat-gui');
  matGui.close(); // 默认收起，拾取零件时自动展开

  matProxy = {
    颜色: '#fbd509', // 起点 = 主题黄（与 applyHighlight 一致）
    金属度: 0,
    粗糙度: 0.5,
    清漆: 0,
    透射: 0,
    透明度: 1,
  };
  // track：所有控制器统一挂 onChange + 收集——syncMatGui 靠 matControllers
  // 逐个 updateDisplay 刷新显示，漏掉任何一个都会出现「零件已换、控件仍
  // 显示上一个零件的值」的错位
  const track = (c) => {
    c.onChange(applyMatProxy);
    matControllers.push(c);
  };
  // 控件名用中文名直接挂代理对象（lil-gui 的 add/addColor 第二参是属性名，
  // 同名即联动），省掉 name() 二次改名的样板
  track(matGui.addColor(matProxy, '颜色'));
  track(matGui.add(matProxy, '金属度', 0, 1, 0.01));
  track(matGui.add(matProxy, '粗糙度', 0, 1, 0.01));
  track(matGui.add(matProxy, '清漆', 0, 1, 0.01));
  track(matGui.add(matProxy, '透射', 0, 1, 0.01));
  track(matGui.add(matProxy, '透明度', 0, 1, 0.01));
}

// 材质 → GUI：拾取/变黄后把选中材质当前值灌进 proxy 并刷新控件显示
function syncMatGui(mesh) {
  const m = mesh.material;
  if (!m || !matProxy) return;
  matProxy.颜色 = '#' + m.color.getHexString();
  matProxy.金属度 = m.metalness;
  matProxy.粗糙度 = m.roughness;
  matProxy.清漆 = m.clearcoat ?? 0;
  matProxy.透射 = m.transmission ?? 0;
  matProxy.透明度 = m.opacity;
  for (const c of matControllers) c.updateDisplay();
}

// 高亮零件：给选中件换上「全局选中材质」。该材质进程内只有一份（首次
// 从触发件的原材质克隆并升级为 MeshPhysicalMaterial——Standard 的子类，
// copy 平移全部参数外观零变化，多出清漆/透射槽位），承载用户的全部
// GUI 调整——零件 A 调蓝后选中 B，B 即以蓝色出现；再调成绿色，回选 A
// 时 A 也是绿色（统一记忆）
let globalSelMat = null; // 全局选中材质（所有零件共享的「高亮皮肤」）
function applyHighlight(mesh) {
  if (!mesh.userData._origMat) mesh.userData._origMat = mesh.material;
  if (!globalSelMat) {
    const orig = mesh.userData._origMat;
    if (orig.isMeshPhysicalMaterial) {
      globalSelMat = orig.clone();
    } else {
      // 不能用 Physical.copy(Standard)——它会无条件拷贝 clearcoatNormalScale
      // 等 Physical 独有的 Vector2 属性，Standard 上是 undefined，直接抛
      // TypeError（「Cannot read properties of undefined (reading 'x')」），
      // 高亮整条链路就此中断。改为：公共属性走基类 copy，Standard 参数逐项平移
      globalSelMat = new THREE.MeshPhysicalMaterial();
      THREE.Material.prototype.copy.call(globalSelMat, orig);
      globalSelMat.color.copy(orig.color);
      globalSelMat.roughness = orig.roughness ?? 1;
      globalSelMat.metalness = orig.metalness ?? 0;
      if (orig.emissive) globalSelMat.emissive.copy(orig.emissive);
      globalSelMat.emissiveIntensity = orig.emissiveIntensity ?? 1;
      globalSelMat.map = orig.map ?? null;
      globalSelMat.normalMap = orig.normalMap ?? null;
      if (orig.normalScale) globalSelMat.normalScale.copy(orig.normalScale);
      globalSelMat.aoMap = orig.aoMap ?? null;
      globalSelMat.transparent = orig.transparent;
      globalSelMat.opacity = orig.opacity;
      globalSelMat.flatShading = !!orig.flatShading;
      globalSelMat.vertexColors = !!orig.vertexColors;
    }
    globalSelMat.color.set('#fbd509'); // 主题黄（base.css --color-primary）
    if (globalSelMat.emissive) globalSelMat.emissive.set(0x664400);
  }
  mesh.material = globalSelMat;
  if (mesh === pickedMesh) syncMatGui(mesh); // GUI 跟进当前选中材质值
}

/* ===================== 相机飞近 ===================== */
// 点击选中零件时，若相机离所选模型太远则平滑飞近：动画期间每帧对
// controls.target 和相机位置做指数插值，贴近视距由模型包围盒反算。
// 已在合适距离内（< FLY_FAR）则不动作，尊重用户当前取景。

/* ===================== 旋转演示 ===================== */
// 转盘/旋钮/滚轮是旋转对称件，选中后绕自身自然轴自转（即真实产品
// 的运动方式）：转盘/旋钮绕世界 Y，滚轮绕世界 X。
// 实现要点：把 mesh attach 到「位于圆心、局部轴对齐世界」的 pivot
// Group 下，转 pivot 即绕过圆心的世界轴转；手推矩阵公式在 gltf 隐藏
// 父变换面前接连出错（漂移/绕错轴/飞出画面），attach 把空间换算全部
// 交给引擎，无公式可错。圆心 = 顶面高度带顶点质心 XZ（转盘/旋钮，
// 全局质心会被底座细节拉偏）或全局顶点质心（滚轮）。
// 角速度由「人手操作」状态机驱动（见 SPIN_STATES）。
const SPIN_PARTS = {
  转盘: new THREE.Vector3(0, 1, 0),
  旋钮: new THREE.Vector3(0, 1, 0),
  滚轮: new THREE.Vector3(1, 0, 0),
};
let spin = null; // { mesh, pivot, origParent, axisWorld, angle, vel, targetVel, partLabel }
const _spinQ = new THREE.Quaternion();

// 「人手」参数：速度域 v（rad/s，正=正方向）与持续时长域 t（s）。
// 档位按速度命名：v2 最快、v1 常速、v0 最慢。
// exclude：该状态对此零件禁用（滚轮没有「快转/细调」的拨法）
const SPIN_STATES = {
  v2: { v: [4, 14], t: [0.1, 0.4], exclude: ['滚轮'] }, // 高速档：大力快转
  v1: { v: [0.3, 0.8], t: [0.3, 0.8] }, // 常速档：常速转动
  v0: { v: [0.6, 1.6], t: [0.2, 0.6], exclude: ['滚轮'] }, // 低速档：小幅细调
  back: { v: [-4, -8], t: [0.15, 0.5] }, // 偶尔反向拨一下
  rest: { v: [0, 0], t: [0.4, 1.6] }, // 手离开，停顿
};

// 按真实操作的概率分布随机切一个新状态：正转占大头（v2+v1+v0
// ≈78%），停顿/反拨是调味料；命中的状态被禁用时顺延到下一档
function nextSpinState(s, partLabel) {
  const r = Math.random();
  let name;
  if (r < 0.4 && !SPIN_STATES.v2.exclude?.includes(partLabel)) name = 'v2';
  else if (r < 0.65) name = 'v1';
  else if (r < 0.78 && !SPIN_STATES.v0.exclude?.includes(partLabel))
    name = 'v0';
  else if (r < 0.9) name = 'rest';
  else name = 'back';
  const cfg = SPIN_STATES[name];
  s.state = name;
  s.targetVel = cfg.v[0] + Math.random() * (cfg.v[1] - cfg.v[0]);
  s.rest = cfg.t[0] + Math.random() * (cfg.t[1] - cfg.t[0]);
}

// 开始自转：建 pivot Group（位于圆心、局部轴对齐世界轴）并把 mesh
// attach 进去，渲染循环只转 pivot 即可
function startSpin(mesh, axisWorld, partLabel) {
  // 世界系圆心 XZ = 顶点质心：
  //   竖直轴件（转盘/旋钮）只取「顶面高度带」（最高 10%）内的顶点——
  //   用户视觉参照是顶面，全局质心会被底座细节拉偏导致旋转发晃；
  //   顶带内顶点全落在圆盘/顶环上，均值即真圆心
  //   滚轮（横轴）取全局质心（已验证稳定）
  const box = new THREE.Box3().setFromObject(mesh);
  const pos = mesh.geometry.attributes.position;
  const vtx = new THREE.Vector3();
  let cx = 0;
  let cz = 0;
  let n = 0;
  if (axisWorld.y !== 0) {
    const bandY = box.max.y - (box.max.y - box.min.y) * 0.1;
    for (let i = 0; i < pos.count; i++) {
      vtx.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      if (vtx.y >= bandY) {
        cx += vtx.x;
        cz += vtx.z;
        n++;
      }
    }
  } else {
    for (let i = 0; i < pos.count; i++) {
      vtx.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      cx += vtx.x;
      cz += vtx.z;
    }
    n = pos.count;
  }
  const centerWorld = box.getCenter(new THREE.Vector3());
  centerWorld.x = cx / n;
  centerWorld.z = cz / n;

  // pivot：位置 = 圆心（换算进父空间）；姿态 = 父世界旋转的逆
  // ⇒ pivot 局部轴与世界轴重合，绕其局部 Y/X 转即绕世界轴转
  const origParent = mesh.parent;
  const pivot = new THREE.Group();
  origParent.add(pivot);
  pivot.position.copy(origParent.worldToLocal(centerWorld.clone()));
  pivot.quaternion.copy(
    origParent.getWorldQuaternion(new THREE.Quaternion()).invert(),
  );
  pivot.attach(mesh); // 世界位姿原封不动地换到 pivot 下，原地待转

  spin = {
    mesh,
    pivot,
    origParent,
    axisWorld: axisWorld.clone(), // 世界系转轴（pivot 局部轴与世界对齐，可直接用）
    angle: 0,
    vel: 0,
    targetVel: 0,
    partLabel, // 零件名：状态机按它过滤 exclude
  };
  nextSpinState(spin, partLabel);
}

// 停止自转：attach 回原父（世界位姿不变），移除 pivot
function stopSpin() {
  if (!spin) return;
  spin.origParent.attach(spin.mesh);
  spin.pivot.removeFromParent();
  spin = null;
}

/* ===================== 按压动画（键位零件） ===================== */
// 键位零件被选中的瞬间：沿世界 -Z 压入 PRESS_DEPTH 再弹回复位，
// 模拟按压。与旋转演示同哲学——mesh attach 到空 pivot，动画只动
// pivot.position，空间换算全部交给引擎；结束后 attach 回原父归位。
const PRESS_PARTS = {
  侧键: new THREE.Vector3(1, 0, 0), // 侧键在侧面，沿 +X 水平压入
  长键: new THREE.Vector3(0, 0, -1),
  短键: new THREE.Vector3(0, 0, -1),
  横键: new THREE.Vector3(0, 0, -1),
  '十字键（上）': new THREE.Vector3(0, 0, -1),
  '十字键（下）': new THREE.Vector3(0, 0, -1),
  '十字键（左）': new THREE.Vector3(0, 0, -1),
  '十字键（右）': new THREE.Vector3(0, 0, -1),
  Tour键: new THREE.Vector3(0, 0, -1),
  C1: new THREE.Vector3(0, 0, -1),
  C2: new THREE.Vector3(0, 0, -1),
};
// .0002,.1
const PRESS_DEPTH = 0.00005; // 压入深度（世界单位）
const PRESS_T = 0.1; // 单程时长（s），全程压入+弹回 = PRESS_T × 2
const PRESS_HL_DELAY = 0.44; // 按压动画结束后到变黄的延迟（s）
let press = null; // { mesh, pivot, origParent, dir, t }
let pendingHlMesh = null; // 待变黄的按压件
let pendingHlT = 0; // 变黄倒计时（s）
// 开始按压：pivot 挂到 mesh 原父节点下，局部轴对齐世界轴（同 startSpin），
// 之后 pivot.position 可直接用世界方向表达；attach 保证 mesh 原地待动
function startPress(mesh, dirWorld) {
  stopPress();
  const origParent = mesh.parent; // 动画结束后 mesh 要 attach 回去的家
  const pivot = new THREE.Group();
  origParent.add(pivot);
  pivot.quaternion.copy(
    origParent.getWorldQuaternion(new THREE.Quaternion()).invert(),
  );
  pivot.attach(mesh);
  press = { mesh, pivot, origParent, dir: dirWorld.clone(), t: 0 };
}

// 停止按压：先把 pivot 归零再 attach 回原父。attach 只保证「世界位姿
// 不变」——若 pivot 停在动画最后一帧的残移量上（帧粒度，可达数像素），
// 直接 attach 会把这个偏移永久带走（「没复位」 bug 的根因）
function stopPress() {
  if (!press) return;
  press.pivot.position.set(0, 0, 0); // 归零后 attach，mesh 世界位姿 = 原始位姿
  press.origParent.attach(press.mesh);
  press.pivot.removeFromParent();
  press = null;
}

// 点击 vs 拖拽判定：按下记位置，抬起时位移 ≤ 4px 且时长 < 400ms 才算点击
let downInfo = null; // { x, y, button, time }
function onPointerDown(e) {
  if (!pickEnabled || disposed) return;
  if (e.button !== 0 && e.button !== 2) return;
  downInfo = { x: e.clientX, y: e.clientY, button: e.button, time: Date.now() };
}

function onPointerUp(e) {
  if (!downInfo || disposed || e.button !== downInfo.button) {
    downInfo = null;
    return;
  }
  const dx = e.clientX - downInfo.x;
  const dy = e.clientY - downInfo.y;
  const moved = Math.hypot(dx, dy) > 4; // 拖拽：交给 controls，不拾取
  const held = Date.now() - downInfo.time > 400; // 长按：不拾取
  const btn = downInfo.button;
  downInfo = null;
  if (moved || held) return;
  pickAt(e, btn);
}

// 找零件所属 glb 的根节点（加载时打有 userData.gltfRoot 标记）
function gltfRootOf(mesh) {
  let root = mesh;
  while (root.parent && !root.userData.gltfRoot) root = root.parent;
  return root;
}

/* ---- 相机飞近：远观时点击零件，相机平滑飞到该模型跟前 ---- */
const FLY_SPEED = 9; // 指数插值速率（1/s）：越大飞得越快、停下越急
let flyGoal = null; // { target: Vector3, pos: Vector3 } 飞行终点，到达即清空
let pendingReveal = null; // 飞行期间挂起的呈现回调（旋转/按压/标注），落地后执行
// 计算并记录飞行终点：target = 所选模型包围盒中心，
// 相机终点 = 沿当前视线方向退到「恰好框住模型」的视距处。
// 返回是否真的起飞（已在取景距离内 = false）
function flyToPart(mesh) {
  const root = gltfRootOf(mesh);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return false;
  const size = box.getSize(new THREE.Vector3());
  const target = box.getCenter(new THREE.Vector3());
  // 视距 = 包围球半径 / sin(半FOV)，与 placeMain 的取景逻辑同源。
  // 视野取纵/横半角中较小者：手机竖屏横向视野明显更窄（FOV 45 时横向半角
  // 只有约 12°），只按纵向算会贴到屏幕左右边缘；窄屏再放大边距系数，
  // 让整台样机完整入画、两侧各留一圈余量
  const vHalf = THREE.MathUtils.degToRad(camera.fov / 2);
  const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
  const margin = camera.aspect < 1 ? 1.35 : 1.15;
  const radius = size.length() / 2;
  const dist = (radius / Math.sin(Math.min(vHalf, hHalf))) * margin;
  /* 最近触发阈值 = 取景距离本身（留 5% 余量）：相机已在取景距离内，
   * 说明用户自己拉近了观察，不再抢视角。阈值随屏幕/模型自适应——
   * 固定值（原 5）在手机上比取景距离还小，落点后每点一次都会重复起飞 */
  if (camera.position.distanceTo(controls.target) <= dist * 1.05) return false;
  const pos = camera.position.clone().sub(target).setLength(dist).add(target);
  flyGoal = { target, pos };
  return true;
}
// 每帧插值：位置与 target 同步趋近终点（指数缓动，先快后慢），
// 距离足够近时吸附终点并结束。用户拖拽会打断飞行（flyGoal 置空于 start 事件）
function stepFly(dt) {
  if (!flyGoal) return;
  const k = 1 - Math.exp(-FLY_SPEED * dt); // 帧率无关的指数插值系数
  camera.position.lerp(flyGoal.pos, k);
  controls.target.lerp(flyGoal.target, k);
  if (camera.position.distanceTo(flyGoal.pos) < 0.01) {
    camera.position.copy(flyGoal.pos);
    controls.target.copy(flyGoal.target);
    flyGoal = null;
    flushPendingReveal(); // 落地：此刻才执行旋转/按压/标注呈现
  }
}
// 执行挂起的呈现回调（若有）
function flushPendingReveal() {
  if (!pendingReveal) return;
  const fn = pendingReveal;
  pendingReveal = null;
  fn();
}

// 拾取本体：btn 0=左键（高亮零件） 2=右键（对焦模型）
function pickAt(e, btn) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(scene.children, true);
  const mesh = hits.find((h) => h.object.isMesh)?.object;
  const hitName = mesh?.name || '';
  // 只认对照表里的 14 个零件；未命中（空白或非键位零件）一律按取消选中处理
  const isNamedPart = mesh && NAMED_PARTS.includes(hitName);

  // 未命中已知零件：取消当前选中，收起材质 GUI。只换回原材质显示，
  // 高亮克隆件（含用户调整）留在 _hlMat 缓存——再次拾取原样恢复
  if (!isNamedPart) {
    if (pickedMesh?.userData._origMat)
      pickedMesh.material = pickedMesh.userData._origMat;
    stopSpin();
    stopPress();
    pendingHlMesh = null; // 作废未兑现的延迟变黄
    pickedMesh = null;
    label.value.visible = false;
    matGui?.close(); // GUI 随取消选中收起
    return;
  }

  // 右键：把零件所属 glb 的包围盒中心设为 controls.target
  if (btn === 2) {
    const box = new THREE.Box3().setFromObject(gltfRootOf(mesh));
    box.getCenter(controls.target);
    controls.update();
    return;
  }

  // 左键：换上高亮材质展示选中。还原上一个选中件只换回原材质显示，
  // 其高亮克隆件（含用户调整）留在缓存；按压件可能尚未换装，_origMat
  // 存在才说明已换装（此时不能把 material 覆盖成 undefined）
  if (pickedMesh && pickedMesh !== mesh && pickedMesh.userData._origMat) {
    pickedMesh.material = pickedMesh.userData._origMat;
  }
  if (spin?.mesh !== mesh) stopSpin(); // 换选：先还原上一个旋转件
  stopPress(); // 按键动画是一次性的，任何新拾取都先复位
  pickedMesh = mesh;
  const label_ = PARTS[hitName];
  // 材质 GUI：非按压件已变黄，灌入高亮材质值（颜色起点 = 主题黄）并展开；
  // 按压件等按压结束变黄时由 applyHighlight 内灌入，这里也先展开
  if (!PRESS_PARTS[label_]) {
    applyHighlight(mesh);
    syncMatGui(mesh);
  }
  matGui?.open();
  // 旋转/按压/标注的呈现：若相机需要飞近，挂起到落地后执行——
  // 先飞到位，再看到零件动起来、引线拉出，叙事顺序自然
  const reveal = () => {
    if (SPIN_PARTS[label_]) startSpin(mesh, SPIN_PARTS[label_], label_);
    if (PRESS_PARTS[label_]) startPress(mesh, PRESS_PARTS[label_]); // 键位：按压
    updateLabel(mesh, label_);
  };
  if (flyToPart(mesh)) {
    pendingReveal = reveal;
  } else {
    reveal();
  }
}

/* ===================== 标注：折线 + 文案 ===================== */
// 把选中零件的世界坐标投影到屏幕：线头钉在零件表面，标签随机落位
const _v = new THREE.Vector3();
function updateLabel(mesh, text) {
  const layer = labelLayerRef.value;
  if (!layer) return;
  const lw = layer.clientWidth;
  const lh = layer.clientHeight;
  // 线头贴零件表面：默认从正上方(down 射线)打顶面；侧键是竖直面，改从侧面打。
  // 短键等 AABB 异常件：包围盒中心可能偏出实体（建模游离点撑大 AABB），
  // 从中心垂直下射会命中侧壁 → 起射点改用「顶点质心」的 XZ，
  // 质心不受游离点影响，永远落在实体正上方。
  const box = new THREE.Box3().setFromObject(mesh);
  box.getCenter(_v);
  const center = _v.clone();
  const isSideKey = /_body78$/.test(mesh.name); // 侧键（对照表：body78）

  // 顶点质心（世界空间）：所有顶点坐标的均值
  const pos = mesh.geometry.attributes.position;
  const vtx = new THREE.Vector3();
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < pos.count; i++) {
    vtx.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    cx += vtx.x;
    cz += vtx.z;
  }
  const cxAvg = cx / pos.count;
  const czAvg = cz / pos.count;

  // 起射点：质心正上方（AABB 中心上方做候选）；取两者都命中的为准
  const origins = isSideKey
    ? [
        // 侧键：从 +X 外侧水平射向质心（TourBox 侧键朝右）
        new THREE.Vector3(box.max.x + 0.5, center.y, czAvg),
        new THREE.Vector3(box.max.x + 0.5, center.y, center.z),
      ]
    : [
        new THREE.Vector3(cxAvg, box.max.y + 0.5, czAvg),
        new THREE.Vector3(center.x, box.max.y + 0.5, center.z),
      ];

  // 依次尝试起射点，第一个有命中的即用其结果
  const ray = new THREE.Raycaster();
  let hit = null;
  for (const origin of origins) {
    ray.set(
      origin,
      isSideKey ? new THREE.Vector3(-1, 0, 0) : new THREE.Vector3(0, -1, 0),
    );
    hit = ray.intersectObject(mesh, false)[0] || null;
    if (hit) break;
  }
  const anchor = hit ? hit.point : center; // 兜底：全部落空就用中心
  anchor.project(camera);
  const fromX = ((anchor.x + 1) / 2) * lw;
  const fromY = ((1 - anchor.y) / 2) * lh;

  // 折线随机参数：以零件名为种子——同一零件每次形状一致（resize 重投影不跳），
  // 不同零件形状各异（保留随机感）。resize 时 fromX/toX 都随画布等比缩放，
  // 折线形态稳定，只有绝对坐标随尺寸平滑变化
  const rnd = seededRand(mesh.name);
  const toX = 16 + rnd() * Math.max(1, lw - 32);
  const toY = 80 + rnd() * 100; // 标签垂直位置限定在 [80px, 180px]
  // 二段折线：零件 → 斜线到肘点 → 水平段 → 标签
  const elbowY = toY;
  // 文案在零件哪侧：随机点在零件左半屏则标签往左拉，反之往右
  const dir = toX < fromX ? -1 : 1;
  /* 标签锚点安全区：手机端舞台窄，随机落点会贴着屏幕边缘，
   * 文案（nowrap）就会有一截被左右边缘裁掉。按文案实测宽度反推锚点范围：
   * 向左展开时锚点是文字右缘（translateX(-100%)），向右展开时是文字左缘 */
  const PAD = 10;
  const chipW = measureChipWidth(text);
  const anchorMin = dir < 0 ? PAD + chipW : PAD;
  const anchorMax = Math.max(anchorMin, lw - PAD - (dir < 0 ? 0 : chipW));
  // 肘点 X：与零件留出随机水平距离，产生长短不一的斜线段
  const elbowX = THREE.MathUtils.clamp(
    fromX + dir * (40 + rnd() * 80),
    anchorMin,
    anchorMax,
  );
  // 水平段长度随机
  const hLen = 32 + rnd() * 64;
  const endX = THREE.MathUtils.clamp(elbowX + dir * hLen, anchorMin, anchorMax);
  labelSeq += 1; // 新拾取 → 新 key → SVG 元素重建 → dash 动画重放
  label.value = {
    visible: true,
    text,
    fromX,
    fromY,
    elbowX,
    elbowY,
    endX,
    // 标签锚点 = 水平段末端；向左展开时锚点为文字右缘（style 里 translateX(-100%)）
    chipX: endX,
    chipY: elbowY,
    alignLeft: dir < 0, // true: 标签整体在锚点左侧
  };
}

// 标签文案宽度：canvas measureText（与 .label-chip 同字号/字重/字体）+ 左右 padding 20px
// 只用于「锚点安全区」计算，几像素误差由 PAD 吸收
let chipMeasureCtx = null;
let chipMeasureFont = '';
function measureChipWidth(text) {
  if (!chipMeasureCtx) {
    chipMeasureCtx = document.createElement('canvas').getContext('2d');
  }
  if (!chipMeasureFont) {
    chipMeasureFont = `600 15px ${getComputedStyle(document.body).fontFamily}`;
  }
  chipMeasureCtx.font = chipMeasureFont;
  return Math.ceil(chipMeasureCtx.measureText(text).width) + 20;
}

// 种子随机：FNV-1a 哈希 + mulberry32——同零件名恒定产出同一序列
//（引线形态稳定，resize 重投影不跳），不同零件互不相同
function seededRand(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ===================== 渲染循环 ===================== */
// 相机漫游（autoOrbit 开关，默认关闭）：水平角匀速公转 + 俯仰/视距正弦
// 振荡，随机相位让每次轨迹不同；用户拖拽期间暂停，松手 2s 以新位姿
// 为基准恢复。同循环内驱动旋转件自转（见 SPIN_STATES 状态机）。
const ORBIT_SPEED = Math.PI / 24; // 水平角速度（rad/s）：7.5°/s，48 秒一圈
const PHI_AMP = 0.75; // 俯仰振荡幅值（rad ≈ 43°）：基准角 ±43°，保证周期性接近正上方俯视
const RHO_AMP = 1.2; // 视距振荡幅值（世界单位）：靠近看细节再拉远看全景
const PHI_MIN = 0.1; // 俯仰下限（rad ≈ 6°，接近地面平视）
const PHI_MAX = 1.45; // 俯仰上限（rad ≈ 83°，接近正上方俯视）
let autoOrbit = false; // 漫游开关
const orbitBase = { phi: 0.35, rho: 8 }; // 漫游基准（用户拖拽后以其位姿重设）
const PHASE = {
  // 随机相位：每次进页面轨迹不同
  phi: Math.random() * Math.PI * 2,
  rho: Math.random() * Math.PI * 2,
};
let userDragging = false;
let resumeAt = 0; // 松手后 2s 恢复漫游
let rebaseNeeded = false;
function startLoop() {
  controls.addEventListener('start', () => {
    userDragging = true;
    flyGoal = null; // 用户接管相机：飞行立即作废
    // 用户开始操作相机（缩放/平移/旋转）：标注是选中瞬间的静态快照，
    // 相机动过就不再对应零件位置，立即隐藏
    label.value.visible = false;
  });
  controls.addEventListener('end', () => {
    userDragging = false;
    resumeAt = performance.now() + 2000;
    rebaseNeeded = true;
  });
  let lastT = performance.now();
  let elapsed = 0;
  function loop() {
    rafId = requestAnimationFrame(loop);
    if (disposed) return;
    const now = performance.now();
    const dt = Math.min((now - lastT) / 1000, 0.05);
    lastT = now;
    elapsed += dt;
    stepFly(dt); // 相机飞近动画（若在飞）

    if (autoOrbit && !userDragging && now >= resumeAt) {
      const offset = camera.position.clone().sub(controls.target);
      const rho = offset.length();
      if (rho > 0.001) {
        // 恢复漫游瞬间：把用户拖完的角度/距离记为新基准
        if (rebaseNeeded) {
          rebaseNeeded = false;
          orbitBase.phi = Math.asin(
            THREE.MathUtils.clamp(offset.y / rho, -1, 1),
          );
          orbitBase.rho = rho;
        }
        // 绝对振荡：phi/rho 直接由「基准 + 正弦」给出（不再围绕当前位置积分）
        const phi = THREE.MathUtils.clamp(
          orbitBase.phi + PHI_AMP * Math.sin(elapsed * 0.21 + PHASE.phi),
          PHI_MIN,
          PHI_MAX,
        );
        const theta = Math.atan2(offset.x, offset.z) + ORBIT_SPEED * dt;
        const nextRho = Math.max(
          1.5,
          orbitBase.rho + RHO_AMP * Math.sin(elapsed * 0.13 + PHASE.rho),
        );
        camera.position.set(
          controls.target.x + nextRho * Math.sin(theta) * Math.cos(phi),
          controls.target.y + nextRho * Math.sin(phi),
          controls.target.z + nextRho * Math.cos(theta) * Math.cos(phi),
        );
      }
    }
    // 旋转件自转：pivot 已位于圆心，每帧重摆其姿态 = Qp⁻¹ · R(angle)
    //（Qp = 父世界旋转）。不能用 rotateOnWorldAxis——它直接前乘、
    // 假设父级无旋转，gltf 父链的旋转会把世界轴共轭成斜轴。
    // 显式组合后 pivot 世界姿态恰为 R：纯绕世界轴旋转，圆心不动。
    if (spin) {
      spin.rest -= dt;
      if (spin.rest <= 0) nextSpinState(spin, spin.partLabel);
      // 角速度缓动：vel 朝状态目标值过渡（人手加减速），状态到期随机切换
      spin.vel += (spin.targetVel - spin.vel) * Math.min(1, dt * 8);
      spin.angle += spin.vel * dt;
      spin.pivot.quaternion.copy(
        spin.origParent.getWorldQuaternion(_spinQ).invert(),
      );
      _spinQ.setFromAxisAngle(spin.axisWorld, spin.angle);
      spin.pivot.quaternion.multiply(_spinQ);
    }
    // 键位按压：前半程 easeOut 压入（快进慢停，像手指发力），后半程
    // easeIn 弹回（慢起快回，像回弹弹簧）。t 走完自动 stopPress 归位
    if (press) {
      press.t += dt;
      const half = PRESS_T;
      let offset;
      if (press.t < half) {
        const k = press.t / half;
        offset = PRESS_DEPTH * (1 - (1 - k) * (1 - k)); // easeOutQuad
      } else if (press.t < half * 2) {
        const k = (press.t - half) / half;
        offset = PRESS_DEPTH * (1 - k * k); // easeInQuad 回弹
      } else {
        // 按压动画走完：延迟片刻再染主题黄（拾取时未变色）
        pendingHlMesh = press.mesh;
        pendingHlT = PRESS_HL_DELAY;
        stopPress();
        offset = 0;
      }
      if (press) {
        // pivot 局部轴已对齐世界轴，position = 世界方向 × 偏移量
        press.pivot.position.copy(press.dir).multiplyScalar(offset);
      }
    }
    // 按压后延迟变黄：倒计时归零且仍为当前选中件时，才染主题黄
    if (pendingHlMesh) {
      pendingHlT -= dt;
      if (pendingHlT <= 0) {
        if (pendingHlMesh === pickedMesh) applyHighlight(pendingHlMesh);
        pendingHlMesh = null;
      }
    }
    controls.update();
    renderer.render(scene, camera);
  }
  loop();
}

/* ===================== 自适应 / 清理 ===================== */
function onResize() {
  if (!renderer) return;
  const container = layoutRef.value?.stageRef;
  if (!container) return;
  const rect = container.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  renderer.setSize(rect.width, rect.height);
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
  // 标注坐标是画布尺寸的函数：resize 后按新尺寸重投影，引线保持钉在零件上
  if (pickedMesh) updateLabel(pickedMesh, label.value.text);
}

function dispose() {
  disposed = true;
  pickEnabled = false;
  // 高亮克隆件缓存与原材质备份随场景一并释放（dispose 遍历里统一处理），
  // 此处只解除 pickedMesh 引用
  pickedMesh = null;
  stopSpin();
  stopPress();
  pendingHlMesh = null; // 作废未兑现的延迟变黄
  cancelAnimationFrame(rafId);
  dracoLoader.dispose(); // 终止解码 worker
  matGui?.destroy(); // lil-gui 随组件卸载销毁
  matGui = null;
  matControllers.length = 0;
  matProxy = null;
  renderer?.domElement.removeEventListener('pointerdown', onPointerDown);
  renderer?.domElement.removeEventListener('pointerup', onPointerUp);
  controls?.dispose();
  scene?.traverse((o) => {
    if (o.isMesh) {
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) m?.dispose();
    }
  });
  renderer?.dispose();
  renderer?.domElement.remove();
  renderer = null;
  scene = null;
  // 全局选中材质可能不在任何 mesh 上（取消选中后仅存于缓存），traverse
  // 够不着，需显式释放（重复 dispose 无害）
  globalSelMat?.dispose();
  globalSelMat = null;
}

onMounted(() => {
  init();
});

onBeforeUnmount(() => {
  dispose();
});
</script>

<style scoped>
/* 零件名标注链接进官网：主题色 + hover 下划线，融进正文排版 */
.tb-link {
  color: var(--color2);
  text-decoration: none;
  border-bottom: 1px dashed currentcolor;
}
.tb-link:hover {
  text-decoration: underline;
}
/* 加载提示小胶囊：居中浮层，移动端/桌面端同一位置（不铺满遮罩，加载中也能看到场景） */
.loading {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 10;
  padding: 8px 14px;
  border-radius: 8px;
  background: rgba(13, 27, 42, 0.8);
  color: #e6edf3;
  font-size: 13px;
}
.label-layer {
  position: absolute;
  inset: 0;
  pointer-events: none; /* 不挡住 canvas 的拖拽/拾取 */
  z-index: 5;
  overflow: hidden;
}
.label-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
/* 引线与文案统一用项目辅色 --color2（亮蓝）：SVG 颜色属性也可直接引用
   CSS 变量，色值单点维护 */
.label-svg path {
  stroke: var(--color2);
  /* 引出动画：pathLength=1 已把线长归一化为 1，dasharray 1 即「一段完整线」；
     offset 从 -1 过渡到 0，虚线窗口从路径末端滑向起点——视觉上引线
     从标签端逐渐拉出、指向零件。resize 重投影只改 d 不重建元素，
     动画只在拾取瞬间（key 变化）重放 */
  stroke-dasharray: 1;
  animation: lead-draw 0.2s ease-out forwards;
}
@keyframes lead-draw {
  from {
    stroke-dashoffset: -1;
  }
  to {
    stroke-dashoffset: 0;
  }
}
.label-svg circle {
  fill: var(--color2);
  /* 线头圆点随引线动画延迟浮现（0.2s 引线画完时出现） */
  animation: dot-pop 0.1s ease-out 0.16s backwards;
}
@keyframes dot-pop {
  from {
    opacity: 0;
    r: 0;
  }
  to {
    opacity: 1;
    r: 3;
  }
}
.label-chip {
  position: absolute;
  padding: 4px 10px;
  color: var(--color2); /* 无背景：纯文案直接用辅色，浅底上清晰 */
  font-size: 15px;
  font-weight: 600;
  line-height: 1.5;
  white-space: nowrap;
  transform: translateY(-50%); /* 以水平线末端为标签垂直中心 */
}
.label-chip.label-left {
  transform: translate(-100%, -50%); /* 左展开：文字整体落在锚点左侧 */
}

/* 屏幕空间摄影棚渐变：直接铺在 ThreeLayout 的 .stage 容器上（scoped
   够不着子组件内部节点，用 :deep() 穿透）。渐变由合成器渲染，
   零运行时开销，且永不随相机旋转/移动变化 */
:deep(.stage) {
  background: linear-gradient(to bottom, #f2f4f7 0%, #dfe3e8 55%, #c3c9d2 100%);
}

/* ---- 选中材质 GUI（lil-gui）：挂在舞台容器内的右上角 ----
 * lil-gui 的 DOM 是命令式 appendChild 的，不带本组件 scoped data-v 属性，
 * 必须 :deep() 穿透（同 :deep(.stage) 的匹配原理）；CSS 变量直接在根元素
 * 上重定义主题，免改 lil-gui 源样式 */
:deep(.mat-gui) {
  position: absolute !important; /* 传入 container 后脱离 autoPlace 流式定位 */
  top: 14px;
  right: 14px;
  z-index: 20; /* 盖过标注层（5） */
  --background-color: rgba(13, 27, 42, 0.88);
  --text-color: #e6edf3;
  --title-background-color: rgba(13, 27, 42, 0.95);
  --widget-color: rgba(230, 237, 243, 0.12);
  --hover-color: rgba(230, 237, 243, 0.2);
  --focus-color: rgba(230, 237, 243, 0.28);
  --font-size: 12px;
}
</style>
