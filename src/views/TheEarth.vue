<template>
  <ThreeLayout
    ref="layoutRef"
    txt-title="地球"
    txt-sub="复刻 threejs.org/manual/#indexed-textures：索引贴图 + 调色板纹理（点击国家蓝色高亮）+ GPU 拾取 + 国名标签投影。"
    txt-hint="点击国家选中 · Shift/Ctrl 多选 · 点空白取消全部 · 右下角 FPS"
    @stage-resize="scheduleRender"
  >
    <template #stage>
      <div ref="labelsRef" class="labels"></div>
      <p class="empty-tip">点击国家选中 · 左键拖转 · 滚轮缩放</p>
    </template>
  </ThreeLayout>
</template>

<script setup>
// —— 案例架构总览（读懂本页只需这一段）——
// 加载两张纹理 + 一份共享 geometry；
// 拾取场景 = indexTexture 直出（像素即 ID）；
// 显示场景 = outlinesTexture 底图 + onBeforeCompile 注入
//   「indexTexture 查 ID → paletteTexture 查颜色 → 加减法合成国界线」；
// palette 是绑着 Uint8Array 的 DataTexture，默认格 0 海洋蓝、其余灰，
// 点击拾取到 ID 后把对应格 set 成 SELECTED_COLOR 并 needsUpdate 重传 2KB。
import { onBeforeUnmount, onMounted, ref } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import Stats from 'stats.js';
import ThreeLayout from '../components/ThreeLayout.vue';
import indexTextureUrl from '../assets/world-data/country-index-texture.png?url';
import outlinesTextureUrl from '../assets/world-data/country-outlines-4k.png?url';
// JSON 直接静态导入（Vite 原生支持，编译期内联为模块）——不用 fetch(?url)
// country-info.json 字段说明（以 China 为例）：
// - name       "China"                    国名 → 标签 DOM 的 textContent
// - lat/lon    33.42 / 106.514            国土代表点 → 经三级旋转链换算成球面 3D 锚点
// - min/max    [73.6,18.2]/[134.8,53.6]   国土包围盒的西南角/东北角 [经度, 纬度]
//                                         → 只用来算 area：标签「画不画」（小国不显示防拥挤）
// - area       932743                     预计算的国土面积（平方度）
// - population {"2005": 1312978855}       各年份人口，本案例未使用
// 消费入口：loadCountryData()；注意数组下标 + 1 = 索引贴图里的国家 ID（0 号留给海洋）
import countryData from '../assets/world-data/country-info.json';

const layoutRef = ref(null);
const labelsRef = ref(null);

let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let stats = null;
let canvas = null;
let pickingScene = null;
let pickingTexture = null;
let pixelBuffer = null;
let paletteTexture = null;
let palette = null;
let countryInfos = null;
let loadedTextures = []; // 所有 loader.load 的纹理，dispose 时逐个释放
let numCountriesSelected = 0;
let renderPending = false; // 是否已有 render 在 rAF 队列里排队
let rafId = 0;
let disposed = false;

// 教程原版常量
const MAX_NUM_COUNTRIES = 512;
const PALETTE_W = MAX_NUM_COUNTRIES;
const PALETTE_H = 1;
// 选中色与项目辅色一致：--color2 = hsl(212 100% 62%) = #3D94FF
const SELECTED_COLOR = [61, 148, 255, 255];
const OCEAN_COLOR = [100, 200, 255, 255];
// 地图五色板（ColorBrewer 低饱和风格）：四色定理保证平面地图 4 色必够让相邻国不同色，
// 留 1 色余量对抗索引贴图边缘抗锯齿产生的「假邻接」
const MAP_COLORS = [
  [166, 206, 227, 255],
  [178, 223, 138, 255],
  [253, 191, 111, 255],
  [202, 178, 214, 255],
  [255, 255, 153, 255],
];
const MAX_CLICK_TIME_MS = 200;
const MAX_MOVE_DELTA_SQ = 5 * 5;

const settings = {
  minArea: 20, // 面积小于它的国家不显示标签
  maxVisibleDot: -0.2, // 点积超过它=转向背面，隐藏标签
};

onMounted(() => {
  init();
});

function init() {
  const container = layoutRef.value.stageRef;
  if (!container || disposed) return;

  camera = new THREE.PerspectiveCamera(60, 2, 0.1, 10);
  camera.position.z = 2.5;

  scene = new THREE.Scene();
  scene.background = new THREE.Color('#246');

  // —— 拾取场景：唯一内容是「索引贴图版」地球（每像素颜色 = 国家 ID） ——
  pickingScene = new THREE.Scene();
  pickingScene.background = new THREE.Color(0);

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
  // 按需渲染配套：交互（拖转/缩放/阻尼惯性）引起的相机变化都要排队重绘
  controls.addEventListener('change', scheduleRender);

  stats = new Stats();
  stats.showPanel(0);
  stats.dom.style.position = 'absolute';
  stats.dom.style.right = '0';
  stats.dom.style.left = 'auto';
  stats.dom.style.bottom = '0';
  stats.dom.style.top = 'auto';
  container.appendChild(stats.dom);

  pickingTexture = new THREE.WebGLRenderTarget(1, 1);
  pixelBuffer = new Uint8Array(4);

  // —— 调色板纹理：宽 512×高 1 的 DataTexture，第 i 个 texel 是国家 i 的显示色 ——
  // GPU 里国家高亮只改这张 2KB 小纹理，不重传任何几何/贴图 —— 这是本案例的精髓
  palette = new Uint8Array(PALETTE_W * 4);
  paletteTexture = new THREE.DataTexture(palette, PALETTE_W, PALETTE_H);
  paletteTexture.minFilter = THREE.NearestFilter;
  paletteTexture.magFilter = THREE.NearestFilter;
  paletteTexture.colorSpace = THREE.SRGBColorSpace;
  resetPalette();

  // —— 两个球共用同一个 SphereGeometry（几何数据只存一份） ——
  const geometry = new THREE.SphereGeometry(1, 64, 32);

  const loader = new THREE.TextureLoader();

  // 拾取球：直接用索引贴图当颜色（贴图像素值 = 国家 ID），MeshBasicMaterial 原样输出
  const indexTexture = loader.load(indexTextureUrl, () => scheduleRender());
  indexTexture.minFilter = THREE.NearestFilter;
  indexTexture.magFilter = THREE.NearestFilter;
  loadedTextures.push(indexTexture);
  const pickingMaterial = new THREE.MeshBasicMaterial({ map: indexTexture });
  pickingScene.add(new THREE.Mesh(geometry, pickingMaterial));

  // 显示球：国界线贴图 + onBeforeCompile 注入「索引→调色板」片元逻辑
  const texture = loader.load(outlinesTextureUrl, () => scheduleRender());
  loadedTextures.push(texture);
  const material = new THREE.MeshBasicMaterial({ map: texture });
  material.onBeforeCompile = function (shader) {
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D indexTexture;
        uniform sampler2D paletteTexture;
        uniform float paletteTextureWidth;
        `,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec4 indexColor = texture2D(indexTexture, vMapUv);
          float index = indexColor.r * 255.0 + indexColor.g * 255.0 * 256.0;
          vec2 paletteUV = vec2((index + 0.5) / paletteTextureWidth, 0.5);
          vec4 paletteColor = texture2D(paletteTexture, paletteUV);
          diffuseColor.rgb = paletteColor.rgb - diffuseColor.rgb; // 相减 = 黑色国界线保留
        }
        `,
      );
    shader.uniforms.indexTexture = { value: indexTexture };
    shader.uniforms.paletteTexture = { value: paletteTexture };
    shader.uniforms.paletteTextureWidth = { value: PALETTE_W };
  };
  scene.add(new THREE.Mesh(geometry, material));

  // —— 交互事件 ——
  canvas.addEventListener('pointerdown', recordStartTimeAndPosition);
  canvas.addEventListener('pointerup', pickCountry);

  // —— 加载国家数据（标签定位用） ——
  loadCountryData();

  onResize();
  // 舞台尺寸变化（txt 收起/展开、窗口缩放）由 ThreeLayout 的 ResizeObserver
  // emit 的 stage-resize 事件驱动，模板上已接 scheduleRender
  window.addEventListener('resize', onResize);
  scheduleRender();
}

// —— 调色板操作 ——
function setPaletteColor(index, color) {
  palette.set(color, index * 4);
}

function resetPalette() {
  colorAllCountries();
  setPaletteColor(0, OCEAN_COLOR); // 索引 0 = 海洋
  paletteTexture.needsUpdate = true; // DataTexture 改数据后必须手动标记重传
}

// —— 彩色国家地图：索引贴图当邻接数据库 + 贪心图着色 ——
// 原理：把 indexTexture 画到离屏 canvas 读出像素；对每个国家扫一遍贴图，
// 「本像素 = 该国 且 右/下相邻像素是另一个国家」→ 两国接壤，记入邻接表。
// 然后 Welsh-Powell 式贪心：按 ID 序每国取「邻国没用过的第一个颜色」。
let countryColor = null;

function buildCountryAdjacencyAndColor() {
  const img = new Image();
  img.src = indexTextureUrl;
  img.onload = () => {
    const cv = document.createElement('canvas');
    const w = img.width;
    const h = img.height;
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    // idAt(x,y)：索引贴图像素 → 国家 ID（R 低 8 位 + G 高 8 位，0 = 海洋/界外）
    const idAt = (x, y) => {
      if (x < 0 || x >= w || y < 0 || y >= h) return 0;
      const i = (y * w + x) * 4;
      return data[i] | (data[i + 1] << 8);
    };
    // 邻接表：adjacency[id] = Set(接壤的国家 id)
    const adjacency = new Map();
    const addEdge = (a, b) => {
      if (a === b || a === 0 || b === 0) return;
      if (!adjacency.has(a)) adjacency.set(a, new Set());
      adjacency.get(a).add(b);
    };
    for (let y = 0; y < h; ++y) {
      for (let x = 0; x < w; ++x) {
        const id = idAt(x, y);
        if (id === 0) continue;
        addEdge(id, idAt(x + 1, y)); // 右邻
        addEdge(id, idAt(x, y + 1)); // 下邻
      }
    }
    // 贪心着色：每国取邻国没用过的第一个颜色
    const numCountries = countryInfos.length;
    countryColor = Array.from({ length: numCountries });
    for (let id = 1; id <= numCountries; ++id) {
      const used = new Set();
      const neighbors = adjacency.get(id);
      if (neighbors) {
        for (const n of neighbors) {
          if (n <= numCountries && countryColor[n - 1] !== undefined) {
            used.add(countryColor[n - 1]);
          }
        }
      }
      let colorIdx = 0;
      while (used.has(colorIdx)) ++colorIdx;
      countryColor[id - 1] = colorIdx % MAP_COLORS.length;
      setPaletteColor(id, MAP_COLORS[countryColor[id - 1]]);
    }
    paletteTexture.needsUpdate = true;
    scheduleRender();
  };
}

// 把所有国家重刷成各自的地图色（初始化与「取消全部选中」共用）
function colorAllCountries() {
  if (!countryColor) {
    buildCountryAdjacencyAndColor();
    return;
  }
  for (let id = 1; id <= countryInfos.length; ++id) {
    setPaletteColor(id, MAP_COLORS[countryColor[id - 1]]);
  }
  paletteTexture.needsUpdate = true;
}

// —— country-info.json → 每个国家一个 DOM 标签（预创建，后续只改 transform/display） ——
function loadCountryData() {
  countryInfos = countryData;
  const lonFudge = Math.PI * 1.5;
  const latFudge = Math.PI;
  // 经纬度 → 3D 位置的旋转辅助链：lonHelper(Y 轴经度) → latHelper(X 轴纬度) → positionHelper(z=1 球面)
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
    const width = max[0] - min[0];
    const height = max[1] - min[1];
    countryInfo.area = width * height;
    const elem = document.createElement('div');
    elem.textContent = countryInfo.nameZH;
    labelParentElem.appendChild(elem);
    countryInfo.elem = elem;
  }

  // 初始机位：经度对准中国（约东经 105°），纬度放平（0° 赤道方向）。
  // 相机须摆在该经度的对面（角度 + π）才能看到它：旋转链把国家正向转到
  // angle 方位，那个方位的点在球背面，视线反方向才是正面
  const cameraDistance = 2.5;
  const chinaLon = countryInfos.find((c) => c.name === 'China')?.lon ?? 105;
  const angle = THREE.MathUtils.degToRad(chinaLon) + lonFudge + Math.PI;
  camera.position.set(Math.sin(angle) * cameraDistance, 0, Math.cos(angle) * cameraDistance);
  camera.lookAt(0, 0, 0);
  scheduleRender();
}

// —— 标签更新：背面剔除（点积） + 3D→CSS 投影 ——
const tempV = new THREE.Vector3();
const cameraToPoint = new THREE.Vector3();
const cameraPosition = new THREE.Vector3();
const normalMatrix = new THREE.Matrix3();

function updateLabels() {
  if (!countryInfos) return;
  const large = settings.minArea * settings.minArea;
  normalMatrix.getNormalMatrix(camera.matrixWorldInverse);
  camera.getWorldPosition(cameraPosition);

  for (const countryInfo of countryInfos) {
    const { position, elem, area, selected } = countryInfo;
    const largeEnough = area >= large;
    const show = selected || (numCountriesSelected === 0 && largeEnough);
    if (!show) {
      elem.style.display = 'none';
      continue;
    }
    // 国土中心向量转到相机相对空间
    tempV.copy(position);
    tempV.applyMatrix3(normalMatrix);
    // 该点指向相机的方向（相机空间）
    cameraToPoint.copy(position);
    cameraToPoint.applyMatrix4(camera.matrixWorldInverse).normalize();
    // 点积 > -0.2 → 已转到背面，隐藏（球边缘也能看到一点，所以阈值是负数）
    const dot = tempV.dot(cameraToPoint);
    if (dot > settings.maxVisibleDot) {
      elem.style.display = 'none';
      continue;
    }
    elem.style.display = '';
    // 3D → NDC → CSS 像素
    tempV.copy(position);
    tempV.project(camera);
    const x = (tempV.x * 0.5 + 0.5) * canvas.clientWidth;
    const y = (tempV.y * -0.5 + 0.5) * canvas.clientHeight;
    elem.style.transform = `translate(-50%, -50%) translate(${x}px,${y}px)`;
    elem.style.zIndex = ((-tempV.z * 0.5 + 0.5) * 100000) | 0;
  }
}

// —— GPU 拾取五步：setViewOffset → 渲到 1×1 离屏 → 读像素 → 解码 ID ——
function pickAt(cssX, cssY) {
  const pixelRatio = renderer.getPixelRatio();
  const dbSize = renderer.getDrawingBufferSize(new THREE.Vector2());
  camera.setViewOffset(dbSize.x, dbSize.y, Math.floor(cssX * pixelRatio), Math.floor(cssY * pixelRatio), 1, 1);
  renderer.setRenderTarget(pickingTexture);
  renderer.render(pickingScene, camera);
  renderer.setRenderTarget(null);
  camera.clearViewOffset();
  renderer.readRenderTargetPixels(pickingTexture, 0, 0, 1, 1, pixelBuffer);
  // 索引贴图的编码：R = id 低 8 位，G = id 高 8 位（支持 65536 个国家，远超 512 上限）
  return (pixelBuffer[0] << 0) | (pixelBuffer[1] << 8);
}

// —— 点击选中国家（区分「点击」与「拖拽旋转」） ——
const startPosition = {};
let startTimeMs = 0;

function getCanvasRelativePosition(event) {
  const rect = canvas.getBoundingClientRect();
  // 返回 CSS 像素偏移（不乘 canvas.width/rect.width！）
  // pickAt 内部会再乘一次 pixelRatio，这里若先乘会双重放大 → 点击永远落空
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function recordStartTimeAndPosition(event) {
  startTimeMs = performance.now();
  const pos = getCanvasRelativePosition(event);
  startPosition.x = pos.x;
  startPosition.y = pos.y;
}

function pickCountry(event) {
  if (!countryInfos) return;
  // 按住太久或移动太多 = 拖拽旋转，不算点击
  const clickTimeMs = performance.now() - startTimeMs;
  if (clickTimeMs > MAX_CLICK_TIME_MS) return;
  const position = getCanvasRelativePosition(event);
  const moveDeltaSq = (startPosition.x - position.x) ** 2 + (startPosition.y - position.y) ** 2;
  if (moveDeltaSq > MAX_MOVE_DELTA_SQ) return;

  const id = pickAt(position.x, position.y);
  if (id > 0) {
    const countryInfo = countryInfos[id - 1];
    const selected = !countryInfo.selected;
    // 无修饰键时单选：先清空全部
    if (selected && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      unselectAllCountries();
    }
    numCountriesSelected += selected ? 1 : -1;
    countryInfo.selected = selected;
    // 只改调色板里 1 格颜色 → needsUpdate 重传 2KB —— 不重渲染任何几何
    setPaletteColor(id, selected ? SELECTED_COLOR : MAP_COLORS[countryColor[id - 1]]);
    paletteTexture.needsUpdate = true;
  } else if (numCountriesSelected) {
    unselectAllCountries();
  }
  scheduleRender();
}

function unselectAllCountries() {
  numCountriesSelected = 0;
  countryInfos.forEach((countryInfo) => {
    countryInfo.selected = false;
  });
  resetPalette();
}

// —— 按需渲染（教程 debounce 版核心）：静止时不渲染，省电 ——
function render() {
  renderPending = false;
  stats.begin();
  onResize();
  controls.update();
  updateLabels();
  renderer.render(scene, camera);
  stats.end();
}

// 排队一次渲染：已有 render 在队列（renderPending）就不再排 —— 合并同帧的多次请求
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
  if (stats && stats.dom) stats.dom.remove();
  // GPU 资源：球几何、两张纹理、调色板 DataTexture、拾取渲染目标
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
  paletteTexture?.dispose();
  paletteTexture = null;
  if (pickingTexture) {
    pickingTexture.dispose();
    pickingTexture = null;
  }
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

onBeforeUnmount(dispose);
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
