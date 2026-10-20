<template>
  <ThreeLayout class="TheEarth__vue" ref="layoutRef" @stage-resize="scheduleRender">
    <!-- 文案面板：显式指定默认 slot 自定义（替代 txt-title/sub/hint props） -->
    <template #default>
      <h2 class="txt-title">地球</h2>
      <p class="txt-sub">
        复刻 threejs.org/manual/#indexed-textures：索引贴图 +
        调色板纹理（点击国家蓝色高亮）+ GPU 拾取 + 国名标签投影。
      </p>
      <p class="txt-hint">点击国家选中 · Shift/Ctrl 多选 · 点空白取消全部</p>
    </template>

    <template #stage>
      <div ref="labelsRef" class="labels"></div>

      <!-- 左上角：时钟按钮（点击切换自转）+ 日期选择器（默认当日，改日期即改光照） -->
      <div class="top-left">
        <button class="clock-btn" :class="{ spinning }" @click="toggleSpin">
          {{ nowText }}
        </button>
        <!-- 日期选择器 + 天数滑块：仅自转模式显示（静止态无昼夜光照，日期无意义） -->
        <input
          v-if="spinning"
          type="date"
          class="date-input"
          :value="dateValue"
          @change="onDateChange"
        />
        <!-- 年内天数滑块：与日期选择器双向联动 -->
        <input
          v-if="spinning"
          type="range"
          class="day-slider"
          min="1"
          max="365"
          :value="dayValue"
          @input="onDaySlide"
        />
      </div>

      <!-- 国家信息面板：1 国单列 / 2 国按点选顺序并排对比 -->
      <div
        v-if="panel.visible"
        class="panel"
        :class="{ compare: panel.countries.length > 1 }"
      >
        <div class="panel-cols">
          <div
            v-for="(c, i) in panel.countries"
            :key="c.name"
            class="panel-col"
          >
            <div class="panel-head">
              <span class="pick-order">{{ i + 1 }}</span>
              <span class="country-name">{{ c.nameZH }}</span>
            </div>
            <div class="country-en">{{ c.name }}</div>
            <div v-for="row in panelRows" :key="row.key" class="row">
              <span class="row-label">{{ row.label }}</span>
              <span class="row-value">{{ row.format(c) }}</span>
            </div>
          </div>
        </div>
        <div v-if="panel.countries.length > 1" class="compare-tip">
          按点选顺序 · 点空白取消
        </div>
      </div>
      <p v-else-if="!spinning" class="empty-tip">
        点击国家查看详情 | Shift + 点击对比两国 | 点击时钟进入自转模式
      </p>
    </template>
  </ThreeLayout>
</template>

<script setup>
/*
 * 主文件只保留主逻辑：生命周期、init 场景搭建、自转模式状态机、
 * 标签投影、拾取事件与按需渲染调度。
 * 无状态工具已按职责抽离到 src/views/earth/：
 *   date.js          ?date= 查询串解析（快捷序号/完整日期）
 *   solar.js         黄赤交角、自转速度、太阳赤纬 Cooper 公式
 *   formatters.js    数值/金额格式化
 *   panel-rows.js    信息面板行定义
 *   palette.js       调色板尺寸/颜色常量 + DataTexture 创建
 *   coloring.js      索引贴图邻接分析 + 贪心图着色
 *   three-objects.js 星空背景/光线箭头/地球材质/地轴纬圈工厂
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import ThreeLayout from '@/components/ThreeLayout.vue';
import indexTextureUrl from '@/assets/world-data/country-index-texture.png?url';
import outlinesTextureUrl from '@/assets/world-data/country-outlines-4k.png?url';
import countryData from '@/assets/world-data/country-info.json';
import { parseSimDate } from '@/views/earth/date';
import {
  EARTH_TILT_DEG,
  SPIN_DEG_PER_SEC,
  SPIN_HOURS_PER_SEC,
  orbitalAngle,
} from '@/views/earth/solar';
import { panelRows } from '@/views/earth/panel-rows';
import {
  MAP_COLORS,
  OCEAN_COLOR,
  PALETTE_W,
  SELECTED_COLOR,
  createPaletteTexture,
  setPaletteColor,
} from '@/views/earth/palette';
import { createColoring } from '@/views/earth/coloring';
import {
  createAxisLine,
  createBackground,
  createEarthMaterial,
  createLatitudeCircle,
  createSunRaysGroup,
  updateSunRays,
} from '@/views/earth/three-objects';

/* =====================================================================
 * 模块变量统一声明区（import 之后、函数之前）：
 *   模板 refs → 模拟日期 → 响应式状态 → 模式快照 → three 核心/场景节点
 *   → 拾取调色板 → 点选渲染状态 → 常量/标签设置 → 计算用临时对象
 * ===================================================================== */

// —— 模板 refs ——
const layoutRef = ref(null);
const labelsRef = ref(null);

// —— 模拟日期：?date= 解析一次（无参数 = 真实今天）；日期选择器可再改 ——
let { date: simDate, text: simDateText } = parseSimDate();

// —— 时钟按钮 / 自转模式 / 信息面板的响应式状态 ——
const nowText = ref('');
let clockTimer = null;
let spinning = ref(false);
const panel = ref({ visible: false, countries: [] });

/* ===================== 日期选择器 ===================== */
const pad2 = (n) => String(n).padStart(2, '0');
// 年内第几天（1~365/366），滑块用
const dayOfYear = (d) =>
  Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);

// 输入框值 YYYY-MM-DD：初始 = URL 日期或当日
const dateValue = ref(
  simDateText ??
    `${simDate.getFullYear()}-${pad2(simDate.getMonth() + 1)}-${pad2(simDate.getDate())}`,
);
const dayValue = ref(dayOfYear(simDate));

// 统一入口：新日期 → 更新两个控件值 + 时钟文字 + 自转中的光照
function applySimDate(date) {
  simDate = date;
  simDateText = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  dateValue.value = simDateText;
  dayValue.value = dayOfYear(date);
  nowText.value = fmtNow();
  if (spinning.value) updateSunDirection(); // 自转中：按新日期重算光照
}

function onDateChange(e) {
  const v = e.target.value; // 'YYYY-MM-DD'，清空时为 ''
  if (!v) return;
  const [y, m, d] = v.split('-').map(Number);
  applySimDate(new Date(y, m - 1, d, 12)); // 中午 12:00，避免跨时区日界（同 date.js 口径）
}

function onDaySlide(e) {
  const day = +e.target.value;
  // 保持当前年份，只改年内天数
  applySimDate(new Date(simDate.getFullYear(), 0, day, 12));
}

/* —— 模式矩阵状态机（每模式一份完整快照） ——
 *   modeStates.idle.MCamera = 静止模式相机矩阵（用户拖拽改变 → 离开静止态时刷新）
 *   modeStates.spin.MCamera = 自转模式相机矩阵 = −Z 轴机位（恒定，初始化固化）
 *   modeStates.*.MObj       = 地球对象矩阵状态（组倾斜 rotation.z + 球自转 rotation.y）
 *
 * 规则：
 * - 静止态：controls 拖拽只改 idle.MCamera（相机），MObj 不变
 * - 切到自转：spin 的 MCamera/MObj 整组应用到相机/组/球
 * - 自转中：每帧只累加 spin.MObj.meshSpinY（并应用到球）
 * - 切回静止：idle 的 MCamera/MObj 整组恢复（画面 = 相机×地球，成对快照）
 */
const modeStates = {
  idle: {
    MCamera: null, // Matrix4：静止态相机矩阵（拖拽实时体现，离开静止态时 snapshot）
    // meshSpinY 必须进快照：只恢复相机会因地球在自转期间转过角度而看不到原国家
    MObj: { groupRotationZ: 0, meshSpinY: 0 },
  },
  spin: {
    MCamera: null, // Matrix4：自转态相机矩阵 = −Z 轴机位（初始化固化，恒定）
    MObj: {
      groupRotationZ: THREE.MathUtils.degToRad(EARTH_TILT_DEG),
      meshSpinY: 0,
    }, // 倾斜+累计自转角
  },
};

// —— three 核心对象 ——
let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let canvas = null;

// —— 场景图节点：地球/背景/箭头 ——
let earthGroup = null; // 承载显示球的组：倾斜施加在组上，球只做 Y 轴自转
let geometry = null; // 两个球共享的 SphereGeometry
let pickingGroup = null; // 拾取球所在组：每帧同步显示球 rotation.y，保证拾取命中
let bgMesh = null; // 星空背景（挂相机，仅自转模式显示）
let bgAspectUniform = null; // 背景 aspect uniform（防星点拉扁）
let sunRaysGroup = null; // 4 条光线箭头（世界空间，绕 Y 随公转定位）
let earthMatApi = null; // 显示球材质 API（取 sunDirVec / sunLightUniform）

// —— 拾取 / 调色板 ——
let pickingScene = null;
let pickingTexture = null;
let pixelBuffer = null;
let paletteTexture = null;
let palette = null;
let coloring = null;
let countryInfos = null;

// —— 点选 / 渲染循环状态 ——
let loadedTextures = []; // loader.load 的纹理，dispose 时逐个释放
let numCountriesSelected = 0;
let pickCounter = 0; // 点选序号：面板列顺序按点选先后排
let renderPending = false; // 是否已有 render 在 rAF 队列
let rafId = 0;
let spinRafId = 0;
let spinLastT = 0;
let disposed = false;

// —— 常量 / 标签显示设置 ——
const MAX_CLICK_TIME_MS = 200;
const MAX_MOVE_DELTA_SQ = 5 * 5;
const settings = {
  minArea: 20, // 面积小于它的国家不显示标签
  maxVisibleDot: -0.2, // 点积超过它=转向背面，隐藏标签
};

// —— 计算用临时对象（避免函数内反复 new） ——
const tempV = new THREE.Vector3();
const cameraToPoint = new THREE.Vector3();
const cameraPosition = new THREE.Vector3();
const normalMatrix = new THREE.Matrix3();
const startPosition = {};
let startTimeMs = 0;

/* =====================================================================
 * 函数区
 * ===================================================================== */

/* ===================== 左上角时钟按钮 ===================== */
function fmtNow() {
  const p = (n) => String(n).padStart(2, '0');
  const base = simDate ?? new Date();
  const ymd =
    simDateText ??
    `${base.getFullYear()}-${p(base.getMonth() + 1)}-${p(base.getDate())}`;
  // 自转模式：日期 + 模拟速度（x.x 小时/秒，口径同 earth.mc665.cn）
  if (spinning.value) return `${ymd} ${SPIN_HOURS_PER_SEC}小时/秒`;
  return `${ymd} ${p(new Date().getHours())}:${p(new Date().getMinutes())}:${p(new Date().getSeconds())}`;
}

function startClock() {
  nowText.value = fmtNow();
  clockTimer = setInterval(() => {
    nowText.value = fmtNow();
  }, 1000);
}

function stopClock() {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
}

/* 太阳方向：由公转角度 θ 直接给出，始终在黄道面（xoz 平面）内。
 * 地轴固定向 −X 倾斜（组 rotation.z = +ε），θ=0（夏至）时太阳在 −X：
 * 北极倾向太阳 → 赤纬 +ε；θ=π（冬至）太阳在 +X → 赤纬 −ε。与相机方位无关。
 * startSpin 与日期变更时调用 */
function updateSunDirection() {
  const theta = orbitalAngle(simDate);
  // 从北黄极俯视逆时针：夏至 −X → 秋分 +Z → 冬至 +X → 春分 −Z
  earthMatApi.sunDirVec.set(-Math.cos(theta), 0, Math.sin(theta));

  camera.updateMatrixWorld(); // decompose 后矩阵未刷新，先同步（startSpin 场景）
  updateSunRays(sunRaysGroup, earthMatApi.sunDirVec);
}

/* ===================== 自转模式状态机 ===================== */
function toggleSpin() {
  if (spinning.value) {
    stopSpin();
  } else {
    startSpin();
  }
}

function startSpin() {
  if (!earthGroup || !modeStates.idle.MCamera) return;
  spinning.value = true;
  controls.enabled = false;
  // 已选国家全部取消，palette 同步复位；面板常关
  unselectAllCountries();
  panel.value.visible = false;
  earthMatApi.setSunLight(1); // 开昼夜光照（着色器未编译时也安全）
  bgMesh.visible = true; // 开星空背景
  scene.background = null; // 纯色背景让位，避免盖不住星空

  /* —— 模式切换：应用 spin 模式快照 —— */
  // ① 静止态完整快照：相机矩阵 + 地球姿态（用户此刻「看着美国」的完整视觉状态）
  modeStates.idle.MCamera.copy(camera.matrixWorld);
  modeStates.idle.MObj.meshSpinY = earthGroup.children[0].rotation.y;
  // ② 自转态相机矩阵整组恢复（恒为 −Z 轴机位）
  modeStates.spin.MCamera.decompose(
    camera.position,
    camera.quaternion,
    camera.scale,
  );
  // ③ 自转态对象矩阵恢复：组倾斜 23.44°，球自转角用 spin 快照里累计的值
  earthGroup.rotation.z = modeStates.spin.MObj.groupRotationZ;
  earthGroup.children[0].rotation.y = modeStates.spin.MObj.meshSpinY;
  if (pickingGroup)
    pickingGroup.children[0].rotation.y = modeStates.spin.MObj.meshSpinY;

  updateSunDirection(); // 太阳方向（光线箭头）
  sunRaysGroup.visible = true;
  nowText.value = fmtNow(); // 按钮立刻切成「年月日 x.x小时/秒」
  spinLastT = performance.now();
  spinRafId = requestAnimationFrame(spinLoop);
}

function stopSpin() {
  spinning.value = false;
  cancelAnimationFrame(spinRafId);
  spinRafId = 0;
  controls.enabled = true;
  earthMatApi.setSunLight(0); // 关昼夜光照，恢复平面无明暗
  if (bgMesh) bgMesh.visible = false; // 关星空背景
  if (sunRaysGroup) sunRaysGroup.visible = false; // 关光线箭头
  if (scene) scene.background = new THREE.Color('#246'); // 恢复纯色背景
  if (earthGroup) {
    /* —— 模式切换：应用 idle 模式快照 —— */
    modeStates.idle.MCamera.decompose(
      camera.position,
      camera.quaternion,
      camera.scale,
    );
    earthGroup.rotation.z = modeStates.idle.MObj.groupRotationZ;
    earthGroup.children[0].rotation.y = modeStates.idle.MObj.meshSpinY;
    if (pickingGroup)
      pickingGroup.children[0].rotation.y = modeStates.idle.MObj.meshSpinY;
    // matrixWorld 立即重算：排队的 render 里 updateLabels 读的是矩阵，不更新会错一帧
    earthGroup.updateMatrixWorld(true);
    controls.target.set(0, 0, 0);
    controls.update();
  }
  nowText.value = fmtNow();
  scheduleRender();
}

function spinLoop(now) {
  if (!spinning.value || !earthGroup) return;
  const dt = Math.min((now - spinLastT) / 1000, 0.1); // 秒；后台切回防爆
  spinLastT = now;
  // 自转作用在球本身（组局部 Y 轴是地轴），倾斜由组的 rotation.z 提供；
  // 拾取组同步同一角度，射线求交才能命中转过去的同一片国土
  const mesh = earthGroup.children[0];
  modeStates.spin.MObj.meshSpinY += THREE.MathUtils.degToRad(
    SPIN_DEG_PER_SEC * dt,
  );
  mesh.rotation.y = modeStates.spin.MObj.meshSpinY;
  if (pickingGroup) pickingGroup.children[0].rotation.y = mesh.rotation.y;
  updateLabels();

  renderer.render(scene, camera);

  spinRafId = requestAnimationFrame(spinLoop);
}

/* ===================== 场景初始化 ===================== */
function init() {
  const container = layoutRef.value.stageRef;
  if (!container || disposed) return;

  camera = new THREE.PerspectiveCamera(60, 2, 0.1, 10);
  camera.position.z = 2.5;

  scene = new THREE.Scene();
  scene.background = new THREE.Color('#246'); // 静止态纯色背景（自转态换星空）
  // 星空背景挂相机（固定屏幕空间，仅自转模式显示）；光线箭头在世界空间（绕 Y 随公转定位）
  const bg = createBackground();
  bgMesh = bg.mesh;
  bgAspectUniform = bg.aspectUniform;
  camera.add(bgMesh);
  scene.add(camera);
  sunRaysGroup = createSunRaysGroup();
  scene.add(sunRaysGroup);

  // —— 拾取场景：唯一内容是「索引贴图版」地球（每像素颜色 = 国家 ID） ——
  pickingScene = new THREE.Scene();
  pickingScene.background = new THREE.Color(0);
  pickingGroup = new THREE.Group();
  pickingScene.add(pickingGroup);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);
  canvas = renderer.domElement;

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 1.2;
  controls.maxDistance = 4;
  controls.update();
  controls.addEventListener('change', scheduleRender);

  pickingTexture = new THREE.WebGLRenderTarget(1, 1);
  pixelBuffer = new Uint8Array(4);

  // 国家数据先就位（静态 JSON），调色板重置/着色需要 countryInfos.length
  countryInfos = countryData;

  // —— 调色板 + 贪心着色 ——
  const paletteObj = createPaletteTexture();
  palette = paletteObj.array;
  paletteTexture = paletteObj.texture;
  coloring = createColoring({
    indexTextureUrl,
    palette,
    onDone: scheduleRender,
  });
  resetPalette();

  // —— 两个球共用同一个 SphereGeometry（几何数据只存一份） ——
  geometry = new THREE.SphereGeometry(1, 64, 32);

  const loader = new THREE.TextureLoader();

  // 拾取球：索引贴图当颜色，MeshBasicMaterial 原样输出
  const indexTexture = loader.load(indexTextureUrl, () => scheduleRender());
  indexTexture.minFilter = THREE.NearestFilter;
  indexTexture.magFilter = THREE.NearestFilter;
  loadedTextures.push(indexTexture);
  const pickingMaterial = new THREE.MeshBasicMaterial({ map: indexTexture });
  pickingGroup.add(new THREE.Mesh(geometry, pickingMaterial));

  // 显示球：国界线贴图 + onBeforeCompile 注入「索引→调色板」与昼夜光照
  const texture = loader.load(outlinesTextureUrl, () => scheduleRender());
  loadedTextures.push(texture);
  earthMatApi = createEarthMaterial({
    texture,
    indexTexture,
    paletteTexture,
    paletteWidth: PALETTE_W,
  });
  // 显示球与拾取球各进一个组：倾斜只加在显示组，自转时两组同步 rotation.y
  earthGroup = new THREE.Group();
  earthGroup.add(new THREE.Mesh(geometry, earthMatApi.material));
  scene.add(earthGroup);

  // 地轴线 + 纬线圈（赤道/南北极圈），常显（自转时随组倾斜）
  earthGroup.add(createAxisLine());
  earthGroup.add(createLatitudeCircle(0)); // 赤道
  earthGroup.add(createLatitudeCircle(66.56)); // 北极圈
  earthGroup.add(createLatitudeCircle(-66.56)); // 南极圈

  // —— 国家 DOM 标签 + 初始机位 + 模式 MCamera 固化 ——
  buildLabels();

  // —— 交互事件 ——
  canvas.addEventListener('pointerdown', recordStartTimeAndPosition);
  canvas.addEventListener('pointerup', pickCountry);

  onResize();
  // 舞台尺寸变化（txt 收起/展开、窗口缩放）：ThreeLayout ResizeObserver →
  // stage-resize 已接 scheduleRender；window.resize 同步相机
  window.addEventListener('resize', onResize);
  scheduleRender();
}

/* ===================== 调色板 ===================== */
function resetPalette() {
  coloring.colorAllCountries(countryInfos, paletteTexture);
  setPaletteColor(palette, 0, OCEAN_COLOR); // 索引 0 = 海洋
  paletteTexture.needsUpdate = true;
}

/* ===================== 国家 DOM 标签构建 ===================== */
// country-info.json → 每个国家一个 DOM 标签（预创建，后续只改 transform/display）
function buildLabels() {
  const lonFudge = Math.PI * 1.5;
  const latFudge = Math.PI;
  // 经纬度 → 3D 位置的旋转辅助链：lonHelper(Y 经度) → latHelper(X 纬度) → positionHelper(z=1)
  const lonHelper = new THREE.Object3D();
  const latHelper = new THREE.Object3D();
  lonHelper.add(latHelper);
  const positionHelper = new THREE.Object3D();
  positionHelper.position.z = 1;
  latHelper.add(positionHelper);
  const labelParentElem = labelsRef.value;

  for (const countryInfo of countryInfos) {
    const { lat, lon, min, max } = countryInfo;
    lonHelper.rotation.y = THREE.MathUtils.degToRad(lon) + lonFudge;
    latHelper.rotation.x = THREE.MathUtils.degToRad(lat) + latFudge;
    positionHelper.updateWorldMatrix(true, false);
    const position = new THREE.Vector3();
    positionHelper.getWorldPosition(position);
    countryInfo.position = position;
    // 包围盒面积决定标签显示门槛（小国标签太挤）
    countryInfo.area = (max[0] - min[0]) * (max[1] - min[1]);
    const elem = document.createElement('div');
    elem.textContent = countryInfo.nameZH;
    labelParentElem.appendChild(elem);
    countryInfo.elem = elem;
  }

  // 静止态初始机位：经度对准中国（约东经 105°），纬度放平；相机摆在该经度对面（+π）
  const cameraDistance = 2.5;
  const chinaLon = countryInfos.find((c) => c.name === 'China')?.lon ?? 105;
  const angle = THREE.MathUtils.degToRad(chinaLon) + lonFudge + Math.PI;
  camera.position.set(
    Math.sin(angle) * cameraDistance,
    0,
    Math.cos(angle) * cameraDistance,
  );
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  modeStates.idle.MCamera = camera.matrixWorld.clone(); // 静止态起点，此后随拖拽被覆盖
  // 自转态机位（恒定）：严格置于 −Z 轴（东经 90° 对面），此时相机右方恰为 −X，
  // 夏至太阳方向 (−1,0,0) 投影到屏幕严格正右（无深度分量）
  const spinPos = new THREE.Vector3(0, 0, -cameraDistance);
  modeStates.spin.MCamera = new THREE.Matrix4()
    .lookAt(spinPos, new THREE.Vector3(), camera.up)
    .setPosition(spinPos);
}

/* ===================== 标签更新：背面剔除 + 3D→CSS 投影 ===================== */
function updateLabels() {
  if (!countryInfos) return;
  const large = settings.minArea * settings.minArea;
  normalMatrix.getNormalMatrix(camera.matrixWorldInverse);
  camera.getWorldPosition(cameraPosition);
  // position 是初始化烘焙的「本征位置」，必须用显示球当前 world matrix 变换到世界空间
  const mesh = earthGroup ? earthGroup.children[0] : null;
  const earthMatrix = mesh ? mesh.matrixWorld : null;

  for (const countryInfo of countryInfos) {
    const { position, elem, area, selected } = countryInfo;
    const show = selected || (numCountriesSelected === 0 && area >= large);
    if (!show) {
      elem.style.display = 'none';
      continue;
    }
    if (earthMatrix) tempV.copy(position).applyMatrix4(earthMatrix);
    else tempV.copy(position);
    tempV.applyMatrix3(normalMatrix);
    if (earthMatrix) cameraToPoint.copy(position).applyMatrix4(earthMatrix);
    else cameraToPoint.copy(position);
    cameraToPoint.applyMatrix4(camera.matrixWorldInverse).normalize();
    // 点积 > -0.2 → 已转到背面，隐藏（球边缘也能看到一点，阈值为负）
    if (tempV.dot(cameraToPoint) > settings.maxVisibleDot) {
      elem.style.display = 'none';
      continue;
    }
    elem.style.display = '';
    if (earthMatrix) tempV.copy(position).applyMatrix4(earthMatrix);
    else tempV.copy(position);
    tempV.project(camera);
    const x = (tempV.x * 0.5 + 0.5) * canvas.clientWidth;
    const y = (tempV.y * -0.5 + 0.5) * canvas.clientHeight;
    elem.style.transform = `translate(-50%, -50%) translate(${x}px,${y}px)`;
    elem.style.zIndex = ((-tempV.z * 0.5 + 0.5) * 100000) | 0;
  }
}

/* ===================== GPU 拾取 ===================== */
// GPU 拾取五步：setViewOffset → 渲到 1×1 离屏 → 读像素 → 解码 ID
function pickAt(cssX, cssY) {
  const pixelRatio = renderer.getPixelRatio();
  const dbSize = renderer.getDrawingBufferSize(new THREE.Vector2());
  camera.setViewOffset(
    dbSize.x,
    dbSize.y,
    Math.floor(cssX * pixelRatio),
    Math.floor(cssY * pixelRatio),
    1,
    1,
  );
  renderer.setRenderTarget(pickingTexture);
  renderer.render(pickingScene, camera);
  renderer.setRenderTarget(null);
  camera.clearViewOffset();
  renderer.readRenderTargetPixels(pickingTexture, 0, 0, 1, 1, pixelBuffer);
  // 编码：R = id 低 8 位，G = id 高 8 位
  return (pixelBuffer[0] << 0) | (pixelBuffer[1] << 8);
}

function getCanvasRelativePosition(event) {
  const rect = canvas.getBoundingClientRect();
  // 返回 CSS 像素偏移；pickAt 内部会乘 pixelRatio，先乘会双重放大 → 点击落空
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function recordStartTimeAndPosition(event) {
  startTimeMs = performance.now();
  const pos = getCanvasRelativePosition(event);
  startPosition.x = pos.x;
  startPosition.y = pos.y;
}

function pickCountry(event) {
  if (!countryInfos) return;
  if (spinning.value) return; // 自转模式：点选禁用
  const clickTimeMs = performance.now() - startTimeMs;
  if (clickTimeMs > MAX_CLICK_TIME_MS) return;
  const position = getCanvasRelativePosition(event);
  const moveDeltaSq =
    (startPosition.x - position.x) ** 2 + (startPosition.y - position.y) ** 2;
  if (moveDeltaSq > MAX_MOVE_DELTA_SQ) return;

  const id = pickAt(position.x, position.y);
  if (id > 0) {
    const countryInfo = countryInfos[id - 1];
    const selected = !countryInfo.selected;
    if (selected && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      unselectAllCountries(); // 无修饰键单选：先清空
    }
    numCountriesSelected += selected ? 1 : -1;
    countryInfo.selected = selected;
    countryInfo.pickOrder = selected ? ++pickCounter : 0;
    // 只改调色板 1 格 → needsUpdate 重传 2KB；取消时还原贪心着色的地图色
    setPaletteColor(
      palette,
      id,
      selected ? SELECTED_COLOR : MAP_COLORS[coloring.getCountryColor(id)],
    );
    paletteTexture.needsUpdate = true;
    syncPanel();
  } else if (numCountriesSelected) {
    unselectAllCountries();
  }
  scheduleRender();
}

/* ===================== 面板同步 ===================== */
// 重建面板列表（按点选先后排序）：选中 0 不展示；1 单国；2 两国对比；≥3 不展示。
// 数组始终如实反映全部选中 → 3 国取消 1 国时面板立即以 2 国对比出现
function syncPanel() {
  panel.value.countries = countryInfos
    .filter((c) => c.selected)
    .sort((a, b) => a.pickOrder - b.pickOrder);
  panel.value.visible = numCountriesSelected >= 1 && numCountriesSelected <= 2;
}

function unselectAllCountries() {
  numCountriesSelected = 0;
  pickCounter = 0;
  countryInfos.forEach((countryInfo) => {
    countryInfo.selected = false;
    countryInfo.pickOrder = 0;
  });
  resetPalette();
  syncPanel();
}

/* ===================== 按需渲染 / 尺寸自适应 / 资源释放 ===================== */
// 按需渲染：静止时不渲染，省电
function render() {
  renderPending = false;
  onResize();
  controls.update();
  updateLabels();
  renderer.render(scene, camera);
}

// 排队一次渲染：已有 render 在队列就不再排 —— 合并同帧多次请求
function scheduleRender() {
  if (disposed) return;
  if (!renderPending) {
    renderPending = true;
    rafId = requestAnimationFrame(render);
  }
}

function onResize() {
  if (!renderer) return;
  const container = layoutRef.value?.stageRef;
  if (!container) return;
  const rect = container.getBoundingClientRect();
  if (rect.width <= 0) return;
  const resized = renderer.getSize(new THREE.Vector2());
  renderer.setSize(rect.width, rect.height);
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
  if (bgAspectUniform) bgAspectUniform.value = camera.aspect; // 星点防拉扁
  if (resized.x !== rect.width || resized.y !== rect.height) {
    scheduleRender();
  }
}

function dispose() {
  if (disposed) return;
  disposed = true;
  cancelAnimationFrame(rafId);
  window.removeEventListener('resize', onResize);
  if (canvas) {
    canvas.removeEventListener('pointerdown', recordStartTimeAndPosition);
    canvas.removeEventListener('pointerup', pickCountry);
  }
  if (controls) controls.dispose();
  // GPU 资源：球几何、材质随场景图（含 camera 子树）遍历释放
  scene?.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const m = o.material;
    if (Array.isArray(m)) m.forEach((x) => x.dispose());
    else if (m) m.dispose();
  });
  pickingScene?.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const m = o.material;
    if (Array.isArray(m)) m.forEach((x) => x.dispose());
    else if (m) m.dispose();
  });
  loadedTextures.forEach((t) => t.dispose());
  loadedTextures = [];
  bgMesh = null;
  bgAspectUniform = null;
  sunRaysGroup = null;
  paletteTexture?.dispose();
  paletteTexture = null;
  pickingTexture?.dispose();
  pickingTexture = null;
  if (labelsRef.value) labelsRef.value.innerHTML = '';
  if (renderer) {
    renderer.dispose();
    renderer.domElement.remove();
    renderer = null;
  }
  scene = null;
  camera = null;
  canvas = null;
}

/* ===================== 生命周期 ===================== */
onMounted(() => {
  init();
  startClock();
});

onBeforeUnmount(() => {
  stopClock();
  if (spinning.value) stopSpin();
  dispose();
});
</script>

<style scoped>
.labels {
  position: absolute;
  z-index: 0;
  left: 0;
  top: 0;
  /* 必须铺满：无宽度时内容塌缩为 0，绝对定位的标签子元素
     可用宽度也是 0 → 中文逐字换行成竖排 */
  width: 100%;
  height: 100%;
  color: white;
  pointer-events: none;
}

/* 标签子元素是 document.createElement 动态创建的 DOM，无 scoped 属性，必须 :deep() 穿透 */
.labels :deep(div) {
  position: absolute;
  left: 0;
  top: 0;
  white-space: nowrap; /* 国名强制单行 */
  font-size: 12px;
  user-select: none;
  pointer-events: none;
  cursor: default;
  text-shadow:
    -1px -1px 0 #000,
    0 -1px 0 #000,
    1px -1px 0 #000,
    1px 0 0 #000,
    1px 1px 0 #000,
    0 1px 0 #000,
    -1px 1px 0 #000,
    -1px 0 0 #000;
}

/* ---- 左上角容器 ---- */
.top-left {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 8px;
  pointer-events: none; /* 容器本身不拦截，子元素各自处理 */
}

.top-left > * {
  pointer-events: auto;
}

/* ---- 时钟按钮 ---- */
.clock-btn {
  font-size: 12px;
  padding: 0 10px;
  height: 30px;
  line-height: 30px;
  font-variant-numeric: tabular-nums; /* 等宽数字：秒跳动时不抖动 */
  color: #fff;
  background: rgba(0, 0, 0, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 4px;
  cursor: pointer; /* 可点击：切换自转模式 */
  user-select: none;
}

/* 自转模式激活：--color-primary 黄底黑字，一眼可辨当前处于「真实自转」 */
.clock-btn.spinning {
  color: #000;
  background: var(--color-primary);
  border-color: #000;
}

/* ---- 日期选择器：与时钟按钮同风格 ---- */
.date-input {
  height: 30px;
  padding: 0 6px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: #fff;
  background: rgba(0, 0, 0, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
}

/* 日历图标反白（默认黑色在深色底上看不清） */
.date-input::-webkit-calendar-picker-indicator {
  filter: invert(1);
  cursor: pointer;
}

/* ---- 年内天数滑块 ---- */
.day-slider {
  width: 140px;
  height: 30px;
  margin: 0;
  accent-color: var(--color-primary); /* 轨道/拇指用主题黄 */
  background: transparent;
  cursor: pointer;
}

/* ---- 国家信息面板（1 国单列 / 2 国并排对比） ---- */
.panel {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 20;
  width: 230px;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.96);
  border: 2px solid #333;
  border-radius: 6px;
  color: #222;
}

/* 对比态：面板放宽到两列 */
.panel.compare {
  width: 400px;
}

.panel-cols {
  display: flex;
  gap: 12px;
}

.panel-col {
  flex: 1;
  min-width: 0;
}

.panel-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 4px;
  margin-bottom: 2px;
  border-bottom: 1px solid #e5e0d5;
}

/* 点选顺序徽标 */
.pick-order {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  font-size: 9px;
  line-height: 14px;
  text-align: center;
  color: #fff;
  background: var(--color2);
  border-radius: 50%;
}

.country-name {
  font-size: 14px;
  font-weight: bold;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.country-en {
  font-size: 10px;
  color: #8a7f66;
  margin-bottom: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  line-height: 2;
}

.row-label {
  color: #8a7f66;
  flex-shrink: 0;
}

.row-value {
  color: #222;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.compare-tip {
  margin-top: 6px;
  padding-top: 4px;
  border-top: 1px dashed #e5e0d5;
  font-size: 9px;
  color: #b0a893;
  text-align: center;
}

/* ---- 底部操作提示（同 DTwin 的 empty-tip 风格） ---- */
.empty-tip {
  position: absolute;
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  padding: 3px 10px;
  font-size: 10px;
  color: #fff;
  background: rgba(0, 0, 0, 0.5);
  border-radius: 4px;
  white-space: nowrap;
  pointer-events: none;
}
</style>
