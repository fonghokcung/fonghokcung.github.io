<template>
  <ThreeLayout ref="layoutRef" @stage-resize="onResize">
    <template #default>
      <h2 class="txt-title">ToolBox · GLB 资产陈列与自动环绕取景</h2>
      <p class="txt-sub">
        批量加载策略：GLTFLoader + Promise.allSettled 并发拉取 4 个 GLB，
        单模型失败降级为占位，页面永不阻塞；每个模型按包围盒最大维度
        归一缩放，底部对齐后等间距排开，整体居中于原点。
      </p>
      <p class="txt-sub">
        自动取景：聚合整体包围盒，由相机 FOV 反算视距与俯仰，
        保证任意模型组合一次入画。漫游相机以球坐标驱动——水平角匀速
        公转，俯仰与视距大幅正弦振荡（可达近正上方俯视），随机相位让
        每次进页面轨迹不同。
      </p>
      <p class="txt-hint">
        用户拖拽/缩放时暂停漫游，松手 2s
        后以新位姿为基准恢复，自动动画与人工操作无冲突
      </p>
    </template>

    <template #stage>
      <div v-if="loading" class="loading">模型加载中…</div>
      <!-- 选中零件的名称标注：白线 + 标签（ref 拿舞台容器做屏幕投影） -->
      <div ref="labelLayerRef" class="label-layer">
        <svg v-show="label.visible" class="label-svg">
          <line
            :x1="label.fromX"
            :y1="label.fromY"
            :x2="label.toX"
            :y2="label.toY"
            stroke="#fff"
            stroke-width="1.5"
          />
          <circle :cx="label.fromX" :cy="label.fromY" r="3" fill="#fff" />
        </svg>
        <span
          v-show="label.visible"
          class="label-chip"
          :style="{ left: label.chipX + 'px', top: label.chipY + 'px' }"
          >{{ label.text }}</span
        >
      </div>
    </template>
  </ThreeLayout>
</template>

<script setup>
/* ToolBox 演示页：GLB 资产陈列 + 自动环绕取景。
 * 资产管线：Promise.allSettled 并发加载，单点失败降级不阻塞；
 * 布局：包围盒归一缩放 → 底部对齐 → 等间距排开；
 * 取景：整体包围盒 + FOV 反算视距；
 * 漫游：球坐标驱动（水平公转 + 俯仰/视距正弦振荡），
 * 用户操作时暂停并以拖后位姿为新基准，自动与人工无冲突 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import ThreeLayout from '@/components/ThreeLayout.vue';
import PART_NAME_MAP from '@/assets/tourbox.txt?raw'; // mesh名 → 官方零件名

const layoutRef = ref(null);
const loading = ref(true);
const labelLayerRef = ref(null);
// 标注层响应式状态：白线两端点 + 标签位置/文字
const label = ref({
  visible: false,
  text: '',
  fromX: 0,
  fromY: 0,
  toX: 0,
  toY: 0,
  chipX: 0,
  chipY: 0,
});

// public/tourbox 下的模型清单（中文文件名由 Vite 原样代理，无需编码处理）
const MODELS = [
  { file: 'tourbox_mesh.glb', label: 'mesh版' },
  { file: '黑色.glb', label: '黑色' },
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
// 拾取调试：raycaster + 指针事件（对照零件名用，定稿后删除）
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pickEnabled = false; // 模型加载完成后才启用

// 解析零件对照表：'旋钮-wang...body67' → { meshName: '旋钮', partName: '旋钮' }
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

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color('#0d1b2a');

  // 照明：半球环境光 + 主平行光 + 补光，白色模型不欠曝、黑色模型有轮廓
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x2a2f3a, 1.8));
  const sun = new THREE.DirectionalLight(0xfff2d6, 2.4);
  sun.position.set(3, 6, 4);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.8);
  fill.position.set(-4, 2, -3);
  scene.add(fill);

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  // 加载期间 loading 提示已覆盖注意力，原点相机渲染空场景合法，无需预设机位

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0.8, 0);
  renderer.domElement.addEventListener('contextmenu', (e) =>
    e.preventDefault(),
  );

  const grid = new THREE.GridHelper(20, 20, 0x3a4a63, 0x243044);
  scene.add(grid);

  loadModels();
  onResize();
  startLoop();
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
}

/* ===================== 加载并排布模型 ===================== */
// 单个 glb → { model, width, label }；失败 resolve null（allSettled 聚合，不阻塞其余）
function loadOne(item) {
  return new Promise((resolve) => {
    new GLTFLoader().load(
      `${import.meta.env.BASE_URL}tourbox/${item.file}`,
      (gltf) => {
        if (disposed) return resolve(null);
        const model = gltf.scene;
        // 只打印 tourbox_mesh 各 mesh 的名字（调试用，定稿后删除）
        if (item.file === 'tourbox_mesh.glb') {
          model.traverse((o) => {
            if (o.isMesh) console.log(`mesh: ${o.name || '(未命名)'}`);
          });
        }

        // 统一缩放：按包围盒最高维度归一（模型大小不一也能并排等高）
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        model.scale.setScalar(2.2 / maxDim);

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

  // allSettled：全失败也不抛异常，结果顺序与 MODELS 一一对应
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

// 点选零件：打印 name + 完整对象 + 高亮成黄色（对照零件名用，定稿后删除）
let pickedMesh = null; // 当前选中零件（左键：高亮）
let focusModel = null; // 当前对焦的 glb 根（右键：设为 controls.target）
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
    pickedMesh = null;
    label.value.visible = false;
    return;
  }

  // 右键：找到零件所属 glb 的根节点，把其包围盒中心设为 controls.target
  if (btn === 2) {
    let root = mesh;
    while (root.parent && !root.userData.gltfRoot) root = root.parent;
    focusModel = root;
    const box = new THREE.Box3().setFromObject(root);
    box.getCenter(controls.target);
    controls.update();
    console.log(
      `focus target → ${focusModel.name || '(glb根)'}`,
      controls.target,
    );
    return;
  }

  // 左键：高亮 + 打印（材质是共享的，需克隆后整卡换色）
  if (pickedMesh && pickedMesh !== mesh) {
    pickedMesh.material = pickedMesh.userData._origMat;
    delete pickedMesh.userData._origMat;
  }
  if (!mesh.userData._origMat) {
    mesh.userData._origMat = mesh.material; // 备份原材质
    mesh.material = mesh.material.clone(); // 克隆后改色，不污染同材质零件
    mesh.material.color.set(0xffd509);
    if (mesh.material.emissive) {
      mesh.material.emissive.set(0x664400);
    }
  }
  pickedMesh = mesh;
  console.log(`picked: ${PARTS[hitName]} (${hitName})`);
  updateLabel(mesh, PARTS[hitName]);
}

// 把选中零件的世界坐标投影到屏幕：起点=零件中心，终点=上方 1/3 随机位置
const _v = new THREE.Vector3();
function updateLabel(mesh, text) {
  const layer = labelLayerRef.value;
  if (!layer) return;
  const lw = layer.clientWidth;
  const lh = layer.clientHeight;
  // 零件包围盒中心 → 世界坐标 → 屏幕坐标
  const box = new THREE.Box3().setFromObject(mesh);
  box.getCenter(_v);
  _v.project(camera);
  const fromX = ((_v.x + 1) / 2) * lw;
  const fromY = ((1 - _v.y) / 2) * lh;
  // 上方 1/3 区域随机落点（留 16px 边距）
  const toX = 16 + Math.random() * Math.max(1, lw - 32);
  const toY = 16 + Math.random() * Math.max(1, lh / 3 - 32);
  label.value = {
    visible: true,
    text,
    fromX,
    fromY,
    toX,
    toY,
    // 标签贴在线的终点上方
    chipX: toX,
    chipY: toY - 28,
  };
}

// 水平等间距排开：mesh版居中于原点并作为取景目标，其余模型在其右侧排开
function arrange(boxes) {
  if (!boxes.length) return; // 全部加载失败：维持默认相机位，避免除零得 0 视距
  const GAP = 0.6;
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
    b.model.position.x += cursor - bb.min.x;
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
// 漫游式公转：水平角 + 俯仰角都随正弦缓摆（非固定圆轨道），视距也周期呼吸，
// 模拟「随便换个角度看看」的观感；速度慢，随机相位让每次进页面轨迹不同。
// 用户拖拽/缩放实时改变球坐标，漫游在新球坐标上叠加继续，互不冲突。
const ORBIT_SPEED = Math.PI / 24; // 水平角速度（rad/s）：7.5°/s，48 秒一圈
const PHI_AMP = 0.75; // 俯仰振荡幅值（rad ≈ 43°）：基准角 ±43°，保证周期性接近正上方俯视
const RHO_AMP = 1.2; // 视距振荡幅值（世界单位）：靠近看细节再拉远看全景
const PHI_MIN = 0.1; // 俯仰下限（rad ≈ 6°，接近地面平视）
const PHI_MAX = 1.45; // 俯仰上限（rad ≈ 83°，接近正上方俯视）
// 漫游式公转开关
let autoOrbit = false;
// 漫游基准（arrange 取景后记录；用户拖拽后以新位姿为基准重设）
const orbitBase = { phi: 0.35, rho: 8 };
// 随机相位：每次进页面轨迹不同
const PHASE = {
  phi: Math.random() * Math.PI * 2,
  rho: Math.random() * Math.PI * 2,
};
// 用户拖拽期间暂停漫游（拖拽与公转抢相机的体验很差），松手 2s 后恢复；
// 恢复时以用户拖完的位姿为新的振荡基准
let userDragging = false;
let resumeAt = 0;
let rebaseNeeded = false;
function startLoop() {
  controls.addEventListener('start', () => {
    userDragging = true;
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
.label-chip {
  position: absolute;
  padding: 4px 12px;
  border-radius: 6px;
  background: rgba(13, 27, 42, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.55);
  color: #fff;
  font-size: 13px;
  line-height: 1.5;
  white-space: nowrap;
  transform: translateX(-50%); /* 以线的终点为标签水平中心 */
}
</style>
