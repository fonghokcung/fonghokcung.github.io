<template>
  <ThreeLayout ref="layoutRef" @stage-resize="scheduleRender">
    <!-- 文案面板：显式指定默认 slot 自定义（替代 txt-title/sub/hint props） -->
    <template #default>
      <h2 class="txt-title">地球</h2>
      <p class="txt-sub">
        复刻 threejs.org/manual/#indexed-textures：索引贴图 +
        调色板纹理（点击国家蓝色高亮）+ GPU 拾取 + 国名标签投影。
      </p>
      <p class="txt-hint">
        点击国家选中 · Shift/Ctrl 多选 · 点空白取消全部 · 右下角 FPS
      </p>
    </template>

    <template #stage>
      <div ref="labelsRef" class="labels"></div>

      <!-- 时钟按钮：左上角，每秒更新；点击切换「真实自转模式」（再点退出） -->
      <button class="clock-btn" :class="{ spinning }" @click="toggleSpin">
        {{ nowText }}
      </button>

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
        点击国家查看指标 · Shift 点击对比两国
      </p>
    </template>
  </ThreeLayout>
</template>

<script setup>
/*
 * 加载两张纹理 + 一份共享 geometry；
 * 拾取场景 = indexTexture 直出（像素即 ID）；
 * 显示场景 = outlinesTexture 底图 + onBeforeCompile 注入
 *   「indexTexture 查 ID → paletteTexture 查颜色 → 加减法合成国界线」；
 * palette 是绑着 Uint8Array 的 DataTexture，默认格 0 海洋蓝、其余灰，
 * 点击拾取到 ID 后把对应格 set 成 SELECTED_COLOR 并 needsUpdate 重传 2KB。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import Stats from 'stats.js';
import ThreeLayout from '@/components/ThreeLayout.vue';
import indexTextureUrl from '@/assets/world-data/country-index-texture.png?url';
import outlinesTextureUrl from '@/assets/world-data/country-outlines-4k.png?url';
import countryData from '@/assets/world-data/country-info.json';

const layoutRef = ref(null);
const labelsRef = ref(null);
// 调试用：init() 里赋值，控制台可随时查看共享球几何（顶点数/索引数/attribute 布局）
let geometry = null;

/* 模拟日期：URL 查询串 ?date= 覆盖「今天」，用来模拟特定日期的太阳直射效果。
 * 两种写法：
 *   完整日期：?date=2026-06-21（- 或 / 分隔、单位数双数皆可），
 *             解析成功后统一为标准「YYYY-MM-DD 双数」形态供展示
 *   快捷序号：?date=1 春分 / 2 夏至 / 3 秋分 / 4 冬至（默认 2026 年）：
 *             δ 各为 0 / +23.44 / 0 / -23.44，可快速对比晨昏线形态
 * 无参数/非法 = 真实今天 */
const SOLSTICE_DATES = ['03-20', '06-21', '09-23', '12-21']; // 1春分 2夏至 3秋分 4冬至
const urlDate = new URLSearchParams(location.search).get('date') || '';
const shortcut = /^[1-4]$/.test(urlDate) ? +urlDate : 0; // 快捷序号 1-4（0=非快捷）
const dateMatch = urlDate.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
const simYear = dateMatch ? +dateMatch[1] : new Date().getFullYear();
const ymdStr = shortcut
  ? `${simYear}-${SOLSTICE_DATES[shortcut - 1]}` // 快捷序号 → 当年对应节气日
  : dateMatch
    ? `${dateMatch[1]}-${String(+dateMatch[2]).padStart(2, '0')}-${String(+dateMatch[3]).padStart(2, '0')}`
    : null;
const simDate = ymdStr
  ? new Date(
      +ymdStr.slice(0, 4),
      +ymdStr.slice(5, 7) - 1,
      +ymdStr.slice(8, 10),
      12,
    )
  : new Date();
const simDateText = ymdStr;

/* ===================== 左上角时钟按钮 ===================== */
const nowText = ref('');
let clockTimer = null;

function fmtNow() {
  const p = (n) => String(n).padStart(2, '0');
  // 有 ?date= 时按钮显示解析后的标准双数日期；否则显示真实今天
  const ymd =
    simDateText ??
    `${simDate.getFullYear()}-${p(simDate.getMonth() + 1)}-${p(simDate.getDate())}`;
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

/* ===================== 真实自转模式 =====================
 * 点击时钟按钮切换：地轴倾斜 23.44°（黄赤交角，J2000 精确值 23°26′21.4″）、
 * controls 禁用（地轴倾斜后拖拽语义混乱）、渲染循环常开、
 * 自转速度 = 每秒 18 经度（≈1.2 小时/秒，口径同 earth.mc665.cn；
 * 真实地球 23h56m 转 360°）
 * 自转模式下：昼夜光照生效、点选禁用、面板关闭并清空已选国家；
 * 再点一次按钮退出：恢复正立姿态、按需渲染。
 */
const EARTH_TILT_DEG = 23.44;
/* 模拟速度（度/真实秒）：18°/s ÷ 360° × 23.9345h（恒星日）≈ 1.2 小时/秒。
 * 换算口径同 earth.mc665.cn 的「4.4 小时/秒」——每真实 1 秒，模拟时间推进多少小时。
 * 供按钮文案展示；实际驱动旋转的仍是 SPIN_DEG_PER_SEC */
const SPIN_DEG_PER_SEC = 18; // 每秒 18 经度 ≈ 1.2 小时/秒（真实地球 23h56m 转 360°）
const SPIN_HOURS_PER_SEC = ((SPIN_DEG_PER_SEC / 360) * 23.9345).toFixed(1); // '1.2'
let spinning = ref(false);
let earthGroup = null; // 承载显示球的组：倾斜施加在组上，球只做 Y 轴自转
let pickingGroup = null; // 拾取球所在组：每帧同步显示球的 rotation.y，保证拾取命中一致
let axisLine = null; // 地轴线（自转模式显示的延长虚线轴）
let spinRafId = 0;
let spinLastT = 0;
let sunLightUniform = null; // 材质里注入的 uLightOn uniform 引用（onBeforeCompile 时捕获）
let sunDirVec = null; // 太阳方向向量（uniform 持有引用；startSpin 时按相机朝向重算）
let bgMesh = null; // 自转模式渐变背景（挂在相机上的全屏平面，亮→暗沿太阳方向）
let bgSunUniform = null; // 背景渐变方向的 uniform 引用（屏幕空间太阳方向，startSpin 时更新）
const bgScreenTmp = new THREE.Vector3(); // 太阳方向→屏幕投影的计算中转（Vector3 方法链需要）
let sunRaysGroup = null; // 自转模式：canvas 左侧 4 条光线箭头（挂相机，指示阳光传播方向）

/* ===================== 模式矩阵状态机（每模式一份完整快照） =====================
 * 命名对应概念：
 *   modeStates.idle.MCamera = 静止模式相机矩阵（用户可拖拽改变 → 离开静止态时刷新）
 *   modeStates.spin.MCamera = 自转模式相机矩阵 = 初始机位（恒定，初始化时固化）
 *   modeStates.*.MObj       = 地球对象矩阵状态（组倾斜 rotation.z + 球自转 rotation.y）
 *
 * 规则（与确认过的行为一一对应）：
 * - 静止态：controls 拖拽只改 idle.MCamera（相机），MObj 不变
 * - 切到自转：spin 的 MCamera/MObj 整组应用到相机/组/球
 * - 自转中：每帧只累加 spin.MObj.meshSpinY（并应用到球）
 * - 切回静止：idle 的 MCamera/MObj 整组恢复（球自转角保存在 spin.MObj 里，
 *   静止态不碰它 → 「保持离开状态前的值」天然成立）
 */
const modeStates = {
  idle: {
    MCamera: null, // Matrix4：静止态相机矩阵（拖拽实时体现，离开静止态时 snapshot）
    // 静止态地球姿态：正立 + 「用户离开静止态那一刻」的球自转角。
    // meshSpinY 必须进快照：画面 = 相机×地球两个因子，只恢复相机会因地球
    // 在自转期间转过角度而导致「回到原视角却看不到原来的国家」
    MObj: { groupRotationZ: 0, meshSpinY: 0 },
  },
  spin: {
    MCamera: null, // Matrix4：自转态相机矩阵 = 初始机位（初始化固化，恒定）
    MObj: {
      groupRotationZ: THREE.MathUtils.degToRad(EARTH_TILT_DEG),
      meshSpinY: 0,
    }, // 倾斜+累计自转角
  },
};

/* 太阳赤纬角（度）：Cooper 近似公式。
 * δ = 23.44° × sin( 360°/365 × (N + 284) )，N = 一年中的第几天。
 * 决定太阳直射点纬度 = δ，亦即晨昏线与经线的夹角。
 * 春分 δ=0（晨昏线过两极⊥赤道）→ 夏至 +23.44°（北极极昼）→ 冬至 -23.44° */
function solarDeclinationDeg(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date - start) / 86400000);
  return 23.44 * Math.sin(((360 / 365) * (dayOfYear + 284) * Math.PI) / 180);
}

function toggleSpin() {
  if (spinning.value) {
    stopSpin();
  } else {
    startSpin();
  }
}

function startSpin() {
  if (!earthGroup || !sunDirVec || !modeStates.idle.MCamera) return;
  spinning.value = true;
  controls.enabled = false;
  // 已选国家全部取消（自转模式下面板常关），palette 同步复位
  unselectAllCountries();
  panel.value.visible = false;
  if (sunLightUniform) sunLightUniform.value = 1; // 开昼夜光照
  bgMesh.visible = true; // 开渐变背景（亮→暗）
  scene.background = null; // 纯色背景让位，避免盖不住渐变

  /* —— 模式切换：应用 spin 模式快照 —— */
  // ① 静止态完整快照：相机矩阵 + 地球姿态（用户此刻「看着美国」的完整视觉状态）
  modeStates.idle.MCamera.copy(camera.matrixWorld);
  modeStates.idle.MObj.meshSpinY = earthGroup.children[0].rotation.y;
  // ② 自转态相机矩阵整组恢复（恒为初始机位）
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

  // 太阳方向：水平分量取「屏幕左」，仰角 δ 沿【地轴】抬起（不是世界 +Y！）。
  // 赤纬 δ 的物理定义 = 太阳方向与赤道面的夹角，合成必须基于赤道面：
  //   ① 地轴（世界空间）= 地球组倾斜后的 +Y（上面 ③ 已应用倾斜，quaternion 即时同步）
  //   ② 屏幕左方向投影到赤道面 → 「赤道面内的屏幕左」
  //   ③ sunDir = ② × cos δ + 地轴 × sin δ（归一化）
  // 若误用世界 +Y 当仰角基准：δ=0 时太阳方向世界水平 → 晨昏线是「世界竖直面」，
  // 与倾斜 23.44° 的赤道面相交成 23.44° 锐角（秋分日晨昏线看起来歪 23° 的根源）；
  // 正确基准下 δ=0 → 晨昏线过两极、⊥赤道；夏至 δ=+23.44° → 北极圈内极昼。
  // δ 同时就是「晨昏线与经线的夹角」：晨昏线偏离极点 δ 度。
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  const camRight = new THREE.Vector3()
    .crossVectors(camDir, new THREE.Vector3(0, 1, 0))
    .normalize();
  const axis = new THREE.Vector3(0, 1, 0)
    .applyQuaternion(earthGroup.quaternion)
    .normalize();
  const sunH = camRight.clone().multiplyScalar(-1); // 屏幕左（世界水平方向）
  sunH.addScaledVector(axis, -sunH.dot(axis)).normalize(); // 投影进赤道面
  const decl = THREE.MathUtils.degToRad(solarDeclinationDeg(simDate));
  sunDirVec
    .copy(sunH)
    .multiplyScalar(Math.cos(decl))
    .addScaledVector(axis, Math.sin(decl))
    .normalize();

  // 背景渐变方向 = 太阳方向在屏幕空间的投影：世界向量变到相机视空间，
  // 取 xy 分量即屏幕平面上的「指向太阳」；亮端指向太阳，渐变与光照方向严格一致。
  // transformDirection 是 Vector3 的方法 → 用模块级临时向量算好再写回 Vector2 uniform
  if (bgSunUniform) {
    bgScreenTmp.copy(sunDirVec).transformDirection(camera.matrixWorldInverse);
    bgSunUniform.value.set(bgScreenTmp.x, bgScreenTmp.y).normalize();
  }
  sunRaysGroup.visible = true;
  updateSunRays(); // 箭头方向与位置按同一屏幕投影刷新
  nowText.value = fmtNow(); // 按钮立刻切成「年月日 x.x小时/秒」，不等下一个 1s 时钟节拍
  spinLastT = performance.now();
  spinRafId = requestAnimationFrame(spinLoop);
}

function stopSpin() {
  spinning.value = false;
  cancelAnimationFrame(spinRafId);
  spinRafId = 0;
  controls.enabled = true;
  if (sunLightUniform) sunLightUniform.value = 0; // 关昼夜光照，恢复平面无明暗
  if (bgMesh) bgMesh.visible = false; // 关渐变背景
  if (sunRaysGroup) sunRaysGroup.visible = false; // 关光线箭头
  if (scene) scene.background = new THREE.Color('#246'); // 恢复纯色背景
  if (earthGroup) {
    /* —— 模式切换：应用 idle 模式快照 —— */
    // ① 静止态相机矩阵恢复（「进自转前」的拖拽视角）
    modeStates.idle.MCamera.decompose(
      camera.position,
      camera.quaternion,
      camera.scale,
    );
    // ② 静止态地球姿态恢复（离开静止时球的自转角）——相机×地球两个因子
    //    都回到离开时的值，画面才会与「离开静止那一刻」完全一致
    earthGroup.rotation.z = modeStates.idle.MObj.groupRotationZ;
    earthGroup.children[0].rotation.y = modeStates.idle.MObj.meshSpinY;
    if (pickingGroup)
      pickingGroup.children[0].rotation.y = modeStates.idle.MObj.meshSpinY;
    // matrixWorld 立即重算：排队的 render 里 updateLabels 读的是矩阵，不更新会错一帧
    earthGroup.updateMatrixWorld(true);
    // controls 恢复接管：同步内部 target，避免与实际相机姿态错位
    controls.target.set(0, 0, 0);
    controls.update();
  }
  nowText.value = fmtNow(); // 按钮立刻切回「年月日 时:分:秒」
  scheduleRender();
}

function spinLoop(now) {
  if (!spinning.value || !earthGroup) return;
  const dt = Math.min((now - spinLastT) / 1000, 0.1); // 秒；后台切回防爆
  spinLastT = now;
  // 自转必须作用在球本身（组的局部 Y 轴才是地轴），倾斜由组的 rotation.z 提供；
  // 拾取组同步同一角度，射线求交才能命中转过去的同一片国土。
  // 累计值写回 spin.MObj.meshSpinY —— 模式快照里的自转角始终是最新的
  const mesh = earthGroup.children[0];
  modeStates.spin.MObj.meshSpinY += THREE.MathUtils.degToRad(
    SPIN_DEG_PER_SEC * dt,
  );
  mesh.rotation.y = modeStates.spin.MObj.meshSpinY;
  if (pickingGroup) pickingGroup.children[0].rotation.y = mesh.rotation.y;
  updateSunRays(); // 相机恒定但窗口比例可变，位置随视口高度自适应
  updateLabels();

  renderer.render(scene, camera);

  spinRafId = requestAnimationFrame(spinLoop);
}

// canvas 左缘 4 条光线箭头：方向 = 光线传播方向 = 太阳方向的反向
// （阳光从太阳射向地球：箭头指向 = -uSunScreen）。相机空间 z=-1 平面处，
// NDC 半高 1 对应相机空间 y=±tan(fov/2)，据此把 NDC 位置换算成相机空间坐标，
// 窗口变高矮时箭头仍贴着左缘排布
function updateSunRays() {
  if (!sunRaysGroup || !bgSunUniform) return;
  const dir = bgSunUniform.value; // 屏幕空间「指向太阳」
  // 传播方向 = 指向太阳的反向；相机空间 z=-1 处直接用该 2D 方向
  const prop = new THREE.Vector3(-dir.x, -dir.y, 0).normalize();
  const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)); // z=-1 平面的相机空间半高
  const halfW = halfH * camera.aspect; // 半宽：NDC x=±1 对应的相机空间 x（宽屏比半高大得多）
  // 赤道屏幕高度实测（不猜偏移量）：取赤道正对相机的点（世界空间 = 地轴×相机右向量，
  // 即倾斜赤道圈上最靠近观察者的点）投影到 NDC，其 y 就是「赤道在画面里的高度」，
  // 箭头组中心直接用它 —— 无论倾斜多少度都精确对准
  const equatorWorld = new THREE.Vector3(0, 1, 0)
    .applyQuaternion(earthGroup.quaternion)
    .normalize(); // 地轴
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  const camRight = new THREE.Vector3()
    .crossVectors(camDir, new THREE.Vector3(0, 1, 0))
    .normalize();
  equatorWorld.cross(camRight).normalize().multiplyScalar(1.0); // 赤道圈上正对相机的那一点（半径 1）
  sunRaysGroup.children.forEach((arrow, i) => {
    arrow.setDirection(prop);
    // 4 支沿「垂直于光线方向」的短线均匀排开：
    // 横向 NDC x≈-0.66（地球左缘 NDC≈-0.39 的外侧，再远一丢丢）；
    // 纵向中心 = 实测赤道屏幕高度，±0.33 半高对称排开
    const perp = new THREE.Vector3(-prop.y, prop.x, 0);
    const center = new THREE.Vector3(
      -0.8 * halfW,
      0.5 * halfH,
      -1,
    ).addScaledVector(perp, halfH * (0.33 - i * 0.22));
    arrow.position.copy(center);
    arrow.setLength(0.09 * halfH, 0.028 * halfH, 0.014 * halfH);
  });
}

/* ===================== 国家信息面板（Vue 侧响应式） =====================
 * 按点选先后顺序维护 selectedList（最多对比 2 国）；
 * 渲染层（three/palette）完全不进响应式。
 */
const panel = ref({ visible: false, countries: [] });

// 面板行定义：key + 展示名 + 格式化函数
const fmtInt = (n) => new Intl.NumberFormat('zh-CN').format(n);
// 金额（美元）人性化格式：万亿/亿单位
const fmtUSD = (n) => {
  if (n == null) return '—';
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)} 万亿`;
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)} 亿`;
  return fmtInt(n);
};
const panelRows = [
  {
    key: 'gdpLatest',
    label: 'GDP 总量',
    format: (c) => fmtUSD(c.gdpLatest),
  },
  {
    key: 'gdpPerCapita',
    label: '人均 GDP',
    format: (c) => {
      if (!c.gdpLatest || !c.populationLatest) return '—';
      return `${fmtInt(Math.round(c.gdpLatest / c.populationLatest))} 美元`;
    },
  },
  {
    key: 'populationLatest',
    label: '人口（2023）',
    format: (c) => (c.populationLatest ? fmtInt(c.populationLatest) : '—'),
  },
  {
    key: 'population',
    label: '人口（2005）',
    format: (c) => fmtInt(c.population?.['2005'] ?? 0),
  },
  {
    key: 'growth',
    label: '人口增长',
    format: (c) => {
      if (!c.populationLatest || !c.population?.['2005']) return '—';
      const pct = (
        (c.populationLatest / c.population['2005'] - 1) *
        100
      ).toFixed(1);
      return `${pct}%`;
    },
  },
  { key: 'area', label: '国土面积（平方度）', format: (c) => fmtInt(c.area) },
  {
    key: 'density',
    label: '人口密度',
    format: (c) => {
      if (!c.populationLatest || !c.area) return '—';
      return `${(c.populationLatest / c.area).toFixed(1)} 人/平方度`;
    },
  },
  {
    key: 'latlon',
    label: '代表点经纬度',
    format: (c) => `${c.lat.toFixed(1)}°, ${c.lon.toFixed(1)}°`,
  },
];

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
let pickCounter = 0; // 点选序号计数器：面板列顺序按点选先后排
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
  startClock();
});

function init() {
  const container = layoutRef.value.stageRef;
  if (!container || disposed) return;

  camera = new THREE.PerspectiveCamera(60, 2, 0.1, 10);
  camera.position.z = 2.5;

  scene = new THREE.Scene();
  scene.background = new THREE.Color('#246');
  // 自转模式渐变背景：全屏平面挂到相机上（scene.add(camera) 后才随相机渲染），
  // 放在远平面内侧，永远垫在地球后面。渐变方向不写死——uSunScreen（屏幕空间
  // 太阳方向）在 startSpin 时算好传入，亮端永远指向太阳来的一侧，与晨昏线方向一致
  bgMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: { uSunScreen: { value: new THREE.Vector2(-1, 0) } }, // 默认屏幕左亮
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy * 2.0, 0.9999, 1.0); // ±0.5 → ±1(NDC)：铺满屏幕
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform vec2 uSunScreen; // 太阳方向在屏幕空间的投影（NDC，y 上正）
        void main() {
          // 灰度渐变：太阳侧亮 rgb(200) → 对侧暗 rgb(10)
          // NDC xy → 渐变坐标：沿 uSunScreen 投影，0=亮端 1=暗端
          vec2 p = vUv * 2.0 - 1.0;                       // uv → NDC [-1,1]
          vec2 s = normalize(uSunScreen);
          float t = clamp(dot(p, s) * -0.5 + 0.5, 0.0, 1.0); // 太阳侧 0 → 背阳侧 1
          float g = mix(200.0, 10.0, t) / 255.0;
          gl_FragColor = vec4(vec3(g), 1.0);
        }
      `,
    }),
  );
  bgMesh.visible = false; // 默认关：静止态仍用纯色 scene.background
  bgSunUniform = bgMesh.material.uniforms.uSunScreen; // 捕获引用，startSpin 时更新渐变方向
  bgMesh.frustumCulled = false;
  bgMesh.renderOrder = -1;
  camera.add(bgMesh);
  scene.add(camera); // 相机的子对象必须相机本身在场景树里才会被渲染

  // —— 自转模式光线指示：canvas 左缘 4 条平行箭头（阳光传播方向）——
  // 挂在相机上（相机空间）：位置恒在画面左侧不随地球转，方向在 startSpin 时
  // 按「太阳方向在屏幕空间的投影」统一旋转。ArrowHelper：线杆 + 锥头
  sunRaysGroup = new THREE.Group();
  const RAY_COUNT = 4;
  for (let i = 0; i < RAY_COUNT; i++) {
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(),
      1,
      0xfbd509,
      0.16,
      0.08,
    );
    arrow.position.set(-0.92, 0.45 - i * 0.3, -1); // 左缘自上而下排开；z=-1 在相机正前方
    arrow.renderOrder = 5; // 画在渐变背景之上
    sunRaysGroup.add(arrow);
  }
  sunRaysGroup.visible = false;
  camera.add(sunRaysGroup);

  // —— 拾取场景：唯一内容是「索引贴图版」地球（每像素颜色 = 国家 ID） ——
  pickingScene = new THREE.Scene();
  pickingScene.background = new THREE.Color(0);
  // 拾取球也放进同姿态的组：自转/倾斜时拾取几何必须与显示几何同步
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
  geometry = new THREE.SphereGeometry(1, 64, 32);

  const loader = new THREE.TextureLoader();

  // 拾取球：直接用索引贴图当颜色（贴图像素值 = 国家 ID），MeshBasicMaterial 原样输出
  const indexTexture = loader.load(indexTextureUrl, () => scheduleRender());
  indexTexture.minFilter = THREE.NearestFilter;
  indexTexture.magFilter = THREE.NearestFilter;
  loadedTextures.push(indexTexture);
  const pickingMaterial = new THREE.MeshBasicMaterial({ map: indexTexture });
  pickingGroup.add(new THREE.Mesh(geometry, pickingMaterial));

  // 显示球：国界线贴图 + onBeforeCompile 注入「索引→调色板」片元逻辑，
  // 并叠加太阳光照（自转模式下亮暗面随晨昏线移动）
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
        uniform vec3 uSunDir;      // 太阳方向（世界空间，指向太阳）
        uniform float uLightOn;    // 1=昼夜光照开（自转模式） 0=关（静止态无明暗）
        varying vec3 vWorldNormal; // 顶点着色器传下的世界空间法线
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
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        {
          // Lambert 明暗：uLightOn=0 时 day 恒为 0？——不，mix(0.15,1,0)=0.15 全暗。
          // 所以关灯时 JS 侧把 uLightOn 设 0，此处用 (1-uLightOn) 补回全亮：
          // uLightOn=0 → factor=1（无明暗）；=1 → factor=day（昼夜）
          float ndl = dot(normalize(vWorldNormal), normalize(uSunDir));
          float day = smoothstep(-0.15, 0.25, ndl);
          float factor = mix(1.0, mix(0.15, 1.0, day), uLightOn);
          gl_FragColor.rgb *= factor;
        }
        `,
      );
    shader.uniforms.indexTexture = { value: indexTexture };
    shader.uniforms.paletteTexture = { value: paletteTexture };
    shader.uniforms.paletteTextureWidth = { value: PALETTE_W };
    shader.uniforms.uSunDir = { value: SUN_DIR };
    shader.uniforms.uLightOn = { value: 0 }; // 默认关：静止态无昼夜
    sunLightUniform = shader.uniforms.uLightOn; // 捕获引用，供自转模式开关
  };
  // 太阳方向向量（初始化占位；startSpin 时按「当前相机的屏幕左方」重算——
  // 初始机位对准中国而非世界 +Z，「屏幕左」≠ 世界 -X，必须用相机右向量推导）
  const SUN_DIR = new THREE.Vector3(-1, 0, 0);
  sunDirVec = SUN_DIR;
  // 顶点着色器补一段：把法线变到世界空间传给片元（MeshBasic 本身不带光照链）
  material.onBeforeCompile = ((orig) => (shader) => {
    orig(shader);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\n varying vec3 vWorldNormal;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n vWorldNormal = normalize(mat3(modelMatrix) * normal);',
      );
  })(material.onBeforeCompile);
  // 显示球与拾取球各进一个组：自转模式下两组同步 rotation.y，倾斜只加在显示组上
  earthGroup = new THREE.Group();
  earthGroup.add(new THREE.Mesh(geometry, material));
  scene.add(earthGroup);

  // 地轴线：贯穿南北极延长 35%，两种模式常显（自转时随组倾斜）。
  // 颜色 = --color-primary（base.css 注释里的源值 #FBD509；GLSL 不认 CSS 变量，
  // 简单场景直接写值，免去 getComputedStyle 桥接；若未来做主题切换再改桥接）
  const axisColor = 0xfbd509;
  const axisPts = [
    new THREE.Vector3(0, -1.35, 0),
    new THREE.Vector3(0, 1.35, 0),
  ];
  axisLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(axisPts),
    new THREE.LineBasicMaterial({ color: axisColor }),
  );
  earthGroup.add(axisLine);

  // 纬线圈辅助线（赤道/南北极圈）：纬度 φ 的圆半径 = cos(φ)，高度 y = sin(φ)。
  // 极圈纬度 = ±66.56°（90° − 黄赤交角 23.44°）
  const helperColor = 0xfbd509;
  const makeLatitudeCircle = (latDeg) => {
    const lat = THREE.MathUtils.degToRad(latDeg);
    const r = Math.cos(lat) * 1.005; // 1.005：略大于球面防 z-fighting
    const y = Math.sin(lat);
    const pts = [];
    const SEGMENTS = 128;
    for (let i = 0; i <= SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: helperColor }),
    );
    earthGroup.add(line);
    return line;
  };

  // 赤道（0°）
  makeLatitudeCircle(0);
  // 北极圈 / 南极圈（±66.56°）
  makeLatitudeCircle(66.56);
  makeLatitudeCircle(-66.56);

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
  camera.position.set(
    Math.sin(angle) * cameraDistance,
    0,
    Math.cos(angle) * cameraDistance,
  );
  camera.lookAt(0, 0, 0);
  // 初始机位定型：立即重算相机世界矩阵，初始化两种模式的 MCamera 快照——
  //   spin.MCamera = 初始机位（恒定不变，自转模式专用）
  //   idle.MCamera = 初始机位（此后随用户拖拽被覆盖 —— controls 改相机后，
  //                  这里存的对象就是「静止态当下矩阵」的持有者）
  camera.updateMatrixWorld(true);
  modeStates.spin.MCamera = camera.matrixWorld.clone();
  modeStates.idle.MCamera = camera.matrixWorld.clone();
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
  // 自转/倾斜时，position 是初始化烘焙的「本征位置」（未旋转），必须用
  // 显示球当前的 world matrix 变换到世界空间；静止时矩阵是单位阵，结果不变
  const mesh = earthGroup ? earthGroup.children[0] : null;
  const earthMatrix = mesh ? mesh.matrixWorld : null;

  for (const countryInfo of countryInfos) {
    const { position, elem, area, selected } = countryInfo;
    const largeEnough = area >= large;
    const show = selected || (numCountriesSelected === 0 && largeEnough);
    if (!show) {
      elem.style.display = 'none';
      continue;
    }
    // 烘焙位置 → 当前世界位置（自转时随球转）
    if (earthMatrix) tempV.copy(position).applyMatrix4(earthMatrix);
    else tempV.copy(position);
    // 国土中心向量转到相机相对空间
    tempV.applyMatrix3(normalMatrix);
    // 该点指向相机的方向（相机空间）
    if (earthMatrix) cameraToPoint.copy(position).applyMatrix4(earthMatrix);
    else cameraToPoint.copy(position);
    cameraToPoint.applyMatrix4(camera.matrixWorldInverse).normalize();
    // 点积 > -0.2 → 已转到背面，隐藏（球边缘也能看到一点，所以阈值是负数）
    const dot = tempV.dot(cameraToPoint);
    if (dot > settings.maxVisibleDot) {
      elem.style.display = 'none';
      continue;
    }
    elem.style.display = '';
    // 3D → NDC → CSS 像素（同样基于当前世界位置）
    if (earthMatrix) tempV.copy(position).applyMatrix4(earthMatrix);
    else tempV.copy(position);
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
  if (spinning.value) return; // 自转模式：点选功能禁用
  // 按住太久或移动太多 = 拖拽旋转，不算点击
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
    // 无修饰键时单选：先清空全部
    if (selected && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      unselectAllCountries();
    }
    numCountriesSelected += selected ? 1 : -1;
    countryInfo.selected = selected;
    // 记录点选序号：面板列顺序按它排，取消中间某国后其余国家顺序不变
    countryInfo.pickOrder = selected ? ++pickCounter : 0;
    // 只改调色板里 1 格颜色 → needsUpdate 重传 2KB —— 不重渲染任何几何
    setPaletteColor(
      id,
      selected ? SELECTED_COLOR : MAP_COLORS[countryColor[id - 1]],
    );
    paletteTexture.needsUpdate = true;
    syncPanel();
  } else if (numCountriesSelected) {
    unselectAllCountries();
  }
  scheduleRender();
}

// 重建面板国家列表（按点选先后顺序排序）并同步可见性：
//   选中 0 → 不展示；1 → 单国；2 → 两国对比；≥3 → 不展示
// 无论当前是否展示，数组始终如实反映全部选中国家 ——
// 这样 3 国取消 1 国（3→2）时面板立即以 2 国对比出现
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
  bgMesh = null; // 几何/材质已随上面 scene.traverse（含 camera 子树）释放
  bgSunUniform = null;
  sunRaysGroup = null;
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

/* ---- 左上角时钟按钮 ---- */
.clock-btn {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 20;
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
