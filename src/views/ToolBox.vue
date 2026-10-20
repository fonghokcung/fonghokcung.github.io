<template>
  <ThreeLayout class="ToolBox__vue" ref="layoutRef" @stage-resize="onResize">
    <!-- https://www.tourboxtech.com/jp/tourbox-elite-natural-series/ -->
    <template #default>
      <h2 class="txt-title">ToolBox · GLB 资产陈列与交互演示</h2>
      <p class="txt-sub">
        批量加载：GLTFLoader + Promise.allSettled 并发拉取，单模型失败
        降级为占位，页面永不阻塞；每个模型按包围盒最大维度归一缩放，
        底部对齐后等间距排开，主角居中于世界原点。
      </p>
      <p class="txt-sub">
        交互演示：左键点选零件高亮并引出折线标注（标签端拉出动画）；
        转盘/旋钮/滚轮是旋转对称件，选中后模拟人手操作自转——快转、
        慢调、偶尔反向、时有停顿；右键将视线聚焦到零件所属模型。
      </p>
      <p class="txt-hint">
        用户拖拽/缩放时标注自动隐藏；相机漫游（autoOrbit）默认关闭，
        可手动开关体验自动环绕取景
      </p>
    </template>

    <template #stage>
      <div v-if="loading" class="loading">模型加载中…</div>
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
    </template>
  </ThreeLayout>
</template>

<script setup>
/* ToolBox 演示页：GLB 资产陈列 + 零件交互演示。
 * 资产管线：Promise.allSettled 并发加载，单点失败降级不阻塞；
 * 布局：包围盒归一缩放 → 底部对齐 → 等间距排开，主角居中于原点；
 * 拾取：14 键位白名单，左键高亮 + 折线标注，右键对焦所属模型；
 * 旋转演示：转盘/旋钮/滚轮绕世界自然轴自转（pivot Group + attach 实现），
 *   角速度由「人手操作」状态机驱动（快转/慢转/细调/停顿/反拨）；
 * 漫游：球坐标驱动相机环绕（autoOrbit 默认关闭），用户操作时让位 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import ThreeLayout from '@/components/ThreeLayout.vue';
import PART_NAME_MAP from '@/assets/tourbox.txt?raw'; // mesh名 → 官方零件名

const layoutRef = ref(null);
const loading = ref(true);
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

// public/tourbox 下的模型清单（中文文件名由 Vite 原样代理，无需编码处理）
const MODELS = [
  { file: 'tourbox_mesh.glb', label: 'mesh版' }, // 主角：零件未合并，可拾取
  { file: '白色.glb', label: '白色' },
  { file: '蓝色.glb', label: '蓝色' },
  { file: '黄色.glb', label: '黄色' },
];

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
// 单个 glb → { model, width, label }；失败 resolve null（allSettled 聚合，不阻塞其余）
function loadOne(item) {
  return new Promise((resolve) => {
    new GLTFLoader().load(
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

  // allSettled：全失败也不抛异常；fulfilled 里可能包着 resolve(null)（加载失败），
  // 过滤后得到就位模型，顺序与 MODELS 一致
  const settled = await Promise.allSettled(MODELS.map(loadOne));
  if (disposed) return;

  const boxes = settled
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter(Boolean);
  for (const b of boxes) {
    b.model.userData.gltfRoot = true; // 右键对焦时识别 glb 根的标记
    root.add(b.model);
  }

  arrange(boxes);
  loading.value = false;
  pickEnabled = true; // 模型就位，启用拾取
}

/* ===================== 拾取与选中 ===================== */
let pickedMesh = null; // 当前选中零件（左键：高亮 + 标注）
// 高亮零件：克隆材质后改主题黄（glb 内零件常共享材质实例，直接改会
// 污染同材质的其他零件）。旋转类在拾取瞬间调用；按压键位延迟到按压
// 动画结束后调用（见 startPress / 渲染循环），幂等
function applyHighlight(mesh) {
  if (mesh.userData._origMat) return; // 已高亮
  mesh.userData._origMat = mesh.material; // 备份原材质
  mesh.material = mesh.material.clone();
  mesh.material.color.set('#fbd509'); // 主题黄（base.css --color-primary）
  if (mesh.material.emissive) mesh.material.emissive.set(0x664400);
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
const FLY_FAR = 5; // 相机到 controls.target 距离超过此值视为「太远」
const FLY_SPEED = 9; // 指数插值速率（1/s）：越大飞得越快、停下越急
let flyGoal = null; // { target: Vector3, pos: Vector3 } 飞行终点，到达即清空
let pendingReveal = null; // 飞行期间挂起的呈现回调（旋转/按压/标注），落地后执行
// 计算并记录飞行终点：target = 所选模型包围盒中心，
// 相机终点 = 沿当前视线方向退到「恰好框住模型」的视距处。
// 返回是否真的起飞（太近忽略 = false）
function flyToPart(mesh) {
  // 太近则忽略：相机已在模型跟前（target 距离 < FLY_FAR）时不动，
  // 避免每次点击都抢走用户的取景
  if (camera.position.distanceTo(controls.target) < FLY_FAR) return false;
  const root = gltfRootOf(mesh);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return false;
  const size = box.getSize(new THREE.Vector3());
  const target = box.getCenter(new THREE.Vector3());
  // 视距 = 包围球半径 / sin(半FOV)，与 arrange 的取景逻辑同源（系数 1.15 留边）
  const radius = size.length() / 2;
  const dist = (radius / Math.sin((Math.PI / 180) * 22.5)) * 1.15;
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

  // 未命中已知零件：取消当前选中（恢复原材质），隐藏标注
  if (!isNamedPart) {
    if (pickedMesh?.userData._origMat) {
      pickedMesh.material = pickedMesh.userData._origMat;
      delete pickedMesh.userData._origMat;
    }
    stopSpin();
    stopPress();
    pendingHlMesh = null; // 作废未兑现的延迟变黄
    pickedMesh = null;
    label.value.visible = false;
    return;
  }

  // 右键：把零件所属 glb 的包围盒中心设为 controls.target
  if (btn === 2) {
    const box = new THREE.Box3().setFromObject(gltfRootOf(mesh));
    box.getCenter(controls.target);
    controls.update();
    return;
  }

  // 左键：高亮选中零件（材质是共享的，需克隆后整卡换色）
  // 还原上一个选中件：_origMat 存在才说明已高亮（按压件可能尚未变色，
  // 此时不能把 material 覆盖成 undefined）
  if (pickedMesh && pickedMesh !== mesh && pickedMesh.userData._origMat) {
    pickedMesh.material = pickedMesh.userData._origMat;
    delete pickedMesh.userData._origMat;
  }
  if (spin?.mesh !== mesh) stopSpin(); // 换选：先还原上一个旋转件
  stopPress(); // 按键动画是一次性的，任何新拾取都先复位
  pickedMesh = mesh;
  const label_ = PARTS[hitName];
  // 变黄时机：按压键位等按压动画结束才变色（见渲染循环），其余立即变黄
  if (!PRESS_PARTS[label_]) applyHighlight(mesh);
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
  // 肘点 X：与零件留出随机水平距离，产生长短不一的斜线段
  const elbowX = THREE.MathUtils.clamp(
    fromX + dir * (40 + rnd() * 80),
    8,
    lw - 8,
  );
  // 水平段长度随机
  const hLen = 32 + rnd() * 64;
  const endX = THREE.MathUtils.clamp(elbowX + dir * hLen, 8, lw - 8);
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

// 水平等间距排开：mesh版居中于原点并作为取景目标，其余模型在其右侧排开
function arrange(boxes) {
  if (!boxes.length) return; // 全部加载失败：维持默认相机位，避免除零得 0 视距
  const GAP = 0.4;
  const main = boxes.find((b) => b.label === 'mesh版') || boxes[0]; // 主角模型

  // 主角居中：X/Z 归零（主角中心 = 世界原点），底部已对齐 y=0
  const mainBox = new THREE.Box3().setFromObject(main.model);
  const mainCenter = mainBox.getCenter(new THREE.Vector3());
  main.model.position.x -= mainCenter.x;
  main.model.position.z -= mainCenter.z;

  // 其余模型从主角右侧依次排开
  let cursor = mainBox.max.x + GAP;
  for (const b of boxes) {
    if (b === main) continue;
    const bb = new THREE.Box3().setFromObject(b.model);
    const w = bb.getSize(new THREE.Vector3()).x;
    b.model.position.x += cursor - bb.min.x + 0.8;
    cursor += w + GAP;
  }

  // 相机取景：以主角中心为 target，视距按主角尺寸定
  const finalBox = new THREE.Box3().setFromObject(main.model);
  const center = finalBox.getCenter(new THREE.Vector3());
  const size = finalBox.getSize(new THREE.Vector3());
  const dist =
    (Math.max(size.x, size.y) / 2 / Math.tan((Math.PI / 180) * 22.5)) * 2.8;
  camera.position.set(center.x, center.y + size.y * 1.4, center.z + dist);
  controls.target.copy(center);
  controls.update();
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
  // 恢复被高亮零件的原材质（克隆材质随 dispose 一并释放）
  if (pickedMesh?.userData._origMat) {
    pickedMesh.material = pickedMesh.userData._origMat;
    delete pickedMesh.userData._origMat;
  }
  pickedMesh = null;
  stopSpin();
  stopPress();
  pendingHlMesh = null; // 作废未兑现的延迟变黄
  cancelAnimationFrame(rafId);
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
}

onMounted(() => {
  init();
});

onBeforeUnmount(() => {
  dispose();
});
</script>

<style scoped>
.loading {
  position: absolute;
  top: 14px;
  left: 14px;
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
</style>
