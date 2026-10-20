<template>
  <!-- 首页不用 ThreeLayout：无 txt 面板，canvas 全屏铺满 -->
  <div ref="stageRef" class="stage HomeView__vue" v-loading="homeLoading">
    <p v-if="loadError" class="loading-tip error">{{ loadError }}</p>

    <!-- 打字机自我介绍：偏左 20% / 偏上 15%，逐句打出 → 整句消失 → 下一句 -->
    <div class="intro">
      <!-- 打字中：文字+背景+光标；打完停留期：文字+背景、光标撤走；消失期：整行不渲染 -->
      <p v-if="typing || holdVisible" class="intro-text">
        {{ displayText }}<span v-if="typing" class="cursor">|</span>
      </p>
    </div>
  </div>
</template>

<script setup>
/**
 * GPGPU 鸟群（flocking）—— three.js 官方示例 webgl_gpgpu_birds_gltf 的移植版。
 *
 * 核心思路（读懂本页只需这一段）：
 * 1. 模拟在「纹理空间」进行：64×64 的两张浮点纹理，一个像素 = 一只鸟，
 *    R/G/B 存位置(x,y,z)、A 存翅膀相位；另一张存速度。
 *    每帧用 GPUComputationRenderer 对这两张纹理做一次自身 ping-pong 迭代，
 *    分离/对齐/聚集 + 逃逸鼠标"猎物"的规则全部写在这两个片元着色器里。
 * 2. 渲染：4000+ 只鸟若每只独立 Mesh 会卡死，做法是整群合并成一个几何体
 *    （模型顶点 × 4096 份），每份额外携带 reference 属性 ——
 *    (birdIndexU, birdIndexV, animU, animV)，顶点着色器用它反查模拟纹理
 *    得到这只鸟的世界位置和朝向，再叠加动画纹理采样出的翅膀扇动。
 *    动画纹理是把 GLTF 的 morph target（翅膀关键帧）按时间烘焙成的 2D 表。
 * 3. CPU 每帧开销：两个 uniform + 一句 compute()，没有逐鸟逻辑。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import * as THREE from 'three';
import Stats from 'stats.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';
// GLSL 抽离：?raw 以字符串导入（与 triangle.frag 用法一致）
import positionFrag from '@/shaders/birds/position.frag?raw';
import velocityFrag from '@/shaders/birds/velocity.frag?raw';
import injectDecl from '@/shaders/birds/inject-decl.vert?raw';
import injectTransform from '@/shaders/birds/inject-transform.vert?raw';

const stageRef = ref(null);
const homeLoading = ref(true);
const loadError = ref('');

/* 遮罩至少展示 1s：模型秒开时转圈圈一闪而过反而刺眼 */
const HOME_MIN_LOADING_MS = 1000;
const homeLoadStartAt = performance.now();
let homeMinTimer = null;

// 模型就绪后调用：距开始加载不足 1s 则补齐差额再撤遮罩
function finishHomeLoading() {
  const begin = () => {
    homeLoading.value = false;
    startIntro(); // 遮罩撤除与打字机首启同步，逐字动画一帧不落
  };
  const remain = HOME_MIN_LOADING_MS - (performance.now() - homeLoadStartAt);
  if (remain > 0) {
    homeMinTimer = setTimeout(() => {
      homeMinTimer = null;
      begin();
    }, remain);
  } else {
    begin();
  }
}

/* ===================== 打字机自我介绍（由主渲染循环 rAF 驱动，零定时器） =====================
 * 逐字打出一句 → 停顿后整句消失 → 原位置继续下一句；
 * 全部说完停 10 秒从头循环。与 dimcoi 首页的打印机效果同源。
 * 时间状态机：每帧对照 performance.now() 推进相位，不再用 setInterval/setTimeout
 * （定时器回调与渲染帧不同步，且后台节流会造成回帧爆发）。
 */
const INTRO_SENTENCES = [
  'Hello，我是有十年经验的前端工程师',
  '熟悉前端架构、性能优化与跨平台开发',
  '长期深耕 Web 视觉化领域，专研 Three.js、WebGL 相关开发',
  '擅长打通 2D 业务页面与 3D 互动场景，从需求到上线独立完成整合开发',
  '兼顾视觉效果、渲染效能与使用者体验',
  '期待和团队一起打造优秀的视觉项目 ^v^',
];
const INTRO_TYPE_MS = 90; // 打字间隔（ms/字）
const INTRO_HOLD_MS = 3300; // 整句停留（末句见 INTRO_LAST_HOLD_MS）
const INTRO_LAST_HOLD_MS = 6000; // 末句停留
const INTRO_GAP_MS = 10000; // 末句消失后的空场，之后从头循环
const displayText = ref('');
const typing = ref(false); // 打字中：光标显示
const holdVisible = ref(false); // 停留展示期：背景条随文字保留

/* 相位机：typing 打字 → hold 整句停留 →（末句）gap 空场 → 回到 typing */
let intro = null; // { si, chars, phase, phaseStart }

function startIntro() {
  intro = { si: 0, chars: 0, phase: 'typing', phaseStart: performance.now() };
  typing.value = true;
  holdVisible.value = true;
  displayText.value = '';
}

function stepIntro(now) {
  const st = intro;
  if (!st) return;
  const text = INTRO_SENTENCES[st.si];

  if (st.phase === 'typing') {
    // 由已流逝时间直接算出应显示的字数（跳帧也能追上，不丢字也不抢跑）
    const n = Math.min(
      text.length,
      Math.floor((now - st.phaseStart) / INTRO_TYPE_MS),
    );
    if (n !== st.chars) {
      st.chars = n;
      displayText.value = text.slice(0, n);
    }
    if (n >= text.length) {
      typing.value = false; // 光标先撤，整句（含背景条）进入停留期
      st.phase = 'hold';
      st.phaseStart = now;
    }
  } else if (st.phase === 'hold') {
    const hold =
      st.si === INTRO_SENTENCES.length - 1 ? INTRO_LAST_HOLD_MS : INTRO_HOLD_MS;
    if (now - st.phaseStart >= hold) {
      displayText.value = '';
      holdVisible.value = false; // 整行（含背景）消失
      if (st.si === INTRO_SENTENCES.length - 1) {
        st.phase = 'gap'; // 末句：空场 10s 后从头循环
        st.phaseStart = now;
      } else {
        st.si++; // 其余句子：下一句立接开打
        st.chars = 0;
        st.phase = 'typing';
        typing.value = true;
        holdVisible.value = true;
        st.phaseStart = now;
      }
    }
  } else if (now - st.phaseStart >= INTRO_GAP_MS) {
    st.si = 0;
    st.chars = 0;
    st.phase = 'typing';
    typing.value = true;
    holdVisible.value = true;
    st.phaseStart = now;
  }
}

function stopIntro() {
  intro = null;
  typing.value = false;
  holdVisible.value = false;
  displayText.value = '';
}

// 窗口缩放自适应（无 txt 面板，布局只有窗口一种变化来源）
let resizeObserver = null;

onMounted(() => {
  resizeObserver = new ResizeObserver((entries) => {
    const rect = entries[0].contentRect;
    if (rect.width > 0 || rect.height > 0) onStageResize();
  });
  resizeObserver.observe(stageRef.value);
  // 打字机不在 mounted 启动：遮罩至少盖 1s，此刻开打等于白白损失前几句，
  // 改为遮罩撤除（finishHomeLoading）时由 loop 内 startIntro() 首启
});

/* ===================== 模拟配置（与官方示例一致） ===================== */
const WIDTH = 64; // 模拟纹理宽高：64×64 = 4096 只鸟
const BIRDS = WIDTH * WIDTH;
const BOUNDS = 800; // 鸟群活动空间（立方体边长），velocity 着色器里也要用
const BOUNDS_HALF = BOUNDS / 2;

/* GLTF 模型：public/gltf 下二选一（与示例一样随机） */
const gltfs = [
  `${import.meta.env.BASE_URL}gltf/Parrot.glb`,
  `${import.meta.env.BASE_URL}gltf/Flamingo.glb`,
];
const colors = [0xccffff, 0xffdeff];
const sizes = [0.2, 0.1];
const selectModel = Math.floor(Math.random() * gltfs.length);

/* ===================== 模拟着色器（与官方示例一致） ===================== */
// GLSL 全部抽离到 src/shaders/birds/：
// position.frag / velocity.frag —— GPUComputationRenderer 的两个模拟片元着色器
// inject-decl.vert / inject-transform.vert —— onBeforeCompile 注入 MeshStandardMaterial
// 顶点着色器的两段片段（声明区 + begin_vertex 位移区），用 replace(token) 拼接

/* ===================== three 侧可变状态 ===================== */
let renderer = null;
let scene = null;
let camera = null;
let stats = null;
let gpuCompute = null;
let velocityVariable = null;
let positionVariable = null;
let positionUniforms = null;
let velocityUniforms = null;
let materialShader = null; // birdMesh 材质 onBeforeCompile 捕获的 shader
let birdMesh = null;
let textureAnimation = null; // 烘焙的翅膀动画纹理
let indicesPerBird = 0; // 单只鸟的索引数（setDrawRange 按它 × 显示数截断）
let disposed = false;
let rafId = 0;
let last = performance.now();

let containerHalfX = 0;
let containerHalfY = 0;
let mouseX = 10000; // 初始放很远 = 无猎物
let mouseY = 10000;

/* —— 自动驱鸟：无真实鼠标输入时，虚拟猎物周期性巡游（用户一动鼠标即让位） —— */
const AUTO_IDLE_MS = 3000; // 鼠标静默多久后启用自动模式
const AUTO_SWEEP_MS = 1500; // 单次巡游时长（缓入缓出扫过一段路径）
const AUTO_REST_MS = 10000; // 两次巡游之间的休息,一次巡游结束后歇 AUTO_REST_MS 秒再发起下一次
let lastPointerAt = 0; // 最近一次真实鼠标移动时刻（0 = 页面加载后即自动）
let autoNextAt = 0; // 下次巡游开始的时刻
let autoSweep = null; // 进行中的巡游 {fromX, fromY, toX, toY, start}

function autoPredator(now) {
  if (now - lastPointerAt < AUTO_IDLE_MS) {
    autoSweep = null; // 用户在操作：自动模式立即让位
    return;
  }
  // 留 20% 边距：虚拟猎物不出主视野
  const halfX = containerHalfX * 0.8;
  const halfY = containerHalfY * 0.8;
  if (autoSweep) {
    // 巡游中：smoothstep 插值，起点缓出终点缓入，鸟群被连续驱赶而非瞬移
    const k = Math.min(1, (now - autoSweep.start) / AUTO_SWEEP_MS);
    const e = k * k * (3 - 2 * k);
    mouseX = autoSweep.fromX + (autoSweep.toX - autoSweep.fromX) * e;
    mouseY = autoSweep.fromY + (autoSweep.toY - autoSweep.fromY) * e;
    if (k >= 1) {
      autoSweep = null;
      autoNextAt = now + AUTO_REST_MS;
    }
    return;
  }
  if (now >= autoNextAt) {
    const rand = (m) => (Math.random() * 2 - 1) * m;
    autoSweep = {
      fromX: rand(halfX),
      fromY: rand(halfY),
      toX: rand(halfX),
      toY: rand(halfY),
      start: now,
    };
  }
}

/* ===================== 模型加载 → 烘焙动画纹理 + 拼装鸟群几何 ===================== */
function nextPowerOf2(n) {
  return Math.pow(2, Math.ceil(Math.log(n) / Math.log(2)));
}

new GLTFLoader().load(
  gltfs[selectModel],
  (gltf) => {
    if (disposed) return; // 组件已卸载（HMR/快速切路由）直接丢弃
    const animations = gltf.animations;
    const durationAnimation = Math.round(animations[0].duration * 60); // 关键帧数 = 动画时长×60
    const birdGeo = gltf.scene.children[0].geometry;
    const morphAttributes = birdGeo.morphAttributes.position;
    const tHeight = nextPowerOf2(durationAnimation);
    const tWidth = nextPowerOf2(birdGeo.getAttribute('position').count);
    indicesPerBird = birdGeo.index.count;
    const tData = new Float32Array(4 * tWidth * tHeight);

    /* 把每个 morph 关键帧 bake 成纹理：列 = 顶点，行 = 动画时间，
     * 顶点着色器按 (顶点id, 时间) 双线性插值采样 → GPU 上"播放"动画 */
    for (let i = 0; i < tWidth; i++) {
      for (let j = 0; j < tHeight; j++) {
        const offset = j * tWidth * 4;

        const curMorph = Math.floor(
          (j / durationAnimation) * morphAttributes.length,
        );
        const nextMorph =
          (Math.floor((j / durationAnimation) * morphAttributes.length) + 1) %
          morphAttributes.length;
        const lerpAmount =
          ((j / durationAnimation) * morphAttributes.length) % 1;

        if (j < durationAnimation) {
          let d0, d1;

          d0 = morphAttributes[curMorph].array[i * 3];
          d1 = morphAttributes[nextMorph].array[i * 3];

          if (d0 !== undefined && d1 !== undefined)
            tData[offset + i * 4] = THREE.MathUtils.lerp(d0, d1, lerpAmount);

          d0 = morphAttributes[curMorph].array[i * 3 + 1];
          d1 = morphAttributes[nextMorph].array[i * 3 + 1];

          if (d0 !== undefined && d1 !== undefined)
            tData[offset + i * 4 + 1] = THREE.MathUtils.lerp(
              d0,
              d1,
              lerpAmount,
            );

          d0 = morphAttributes[curMorph].array[i * 3 + 2];
          d1 = morphAttributes[nextMorph].array[i * 3 + 2];

          if (d0 !== undefined && d1 !== undefined)
            tData[offset + i * 4 + 2] = THREE.MathUtils.lerp(
              d0,
              d1,
              lerpAmount,
            );

          tData[offset + i * 4 + 3] = 1;
        }
      }
    }

    textureAnimation = new THREE.DataTexture(
      tData,
      tWidth,
      tHeight,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    textureAnimation.needsUpdate = true;

    /* 鸟群几何 = 基础模型顶点 × BIRDS 份。每份带：
     * reference —— 这只鸟在模拟纹理里的 uv + 动画纹理 uv
     * seeds     —— 每只鸟的随机种子（个体差异：尺寸抖动、相位错开） */
    const vertices = [];
    const color = [];
    const reference = [];
    const seeds = [];
    const indices = [];
    const vertexCount = birdGeo.getAttribute('position').count;
    const totalVertices = vertexCount * 3 * BIRDS;
    for (let i = 0; i < totalVertices; i++) {
      const bIndex = i % (vertexCount * 3);
      vertices.push(birdGeo.getAttribute('position').array[bIndex]);
      color.push(birdGeo.getAttribute('color').array[bIndex]);
    }

    let r = Math.random();
    for (let i = 0; i < vertexCount * BIRDS; i++) {
      const bIndex = i % vertexCount;
      const bird = Math.floor(i / vertexCount);
      if (bIndex == 0) r = Math.random();
      const j = ~~bird;
      const x = (j % WIDTH) / WIDTH;
      const y = ~~(j / WIDTH) / WIDTH;
      reference.push(x, y, bIndex / tWidth, durationAnimation / tHeight);
      seeds.push(bird, r, Math.random(), Math.random());
    }

    for (let i = 0; i < birdGeo.index.array.length * BIRDS; i++) {
      const offset = Math.floor(i / birdGeo.index.array.length) * vertexCount;
      indices.push(
        birdGeo.index.array[i % birdGeo.index.array.length] + offset,
      );
    }

    const BirdGeometry = new THREE.BufferGeometry();
    BirdGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(vertices), 3),
    );
    BirdGeometry.setAttribute(
      'birdColor',
      new THREE.BufferAttribute(new Float32Array(color), 3),
    );
    BirdGeometry.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(color), 3),
    );
    BirdGeometry.setAttribute(
      'reference',
      new THREE.BufferAttribute(new Float32Array(reference), 4),
    );
    BirdGeometry.setAttribute(
      'seeds',
      new THREE.BufferAttribute(new Float32Array(seeds), 4),
    );

    BirdGeometry.setIndex(indices);

    init(BirdGeometry);
    finishHomeLoading(); // 场景就绪，遮罩至少展示 1s 后再撤
  },
  undefined,
  (err) => {
    if (disposed) return;
    finishHomeLoading(); // 失败也要撤遮罩（露出错误提示）
    loadError.value = '模型加载失败：' + (err?.message ?? err);
  },
);

/* ===================== 初始化场景（模型就绪后调用） ===================== */
function init(birdGeometry) {
  const container = stageRef.value;

  camera = new THREE.PerspectiveCamera(75, 1, 1, 3000);
  camera.position.z = 350;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(colors[selectModel]);
  scene.fog = new THREE.Fog(colors[selectModel], 100, 1000);

  // LIGHTS
  const hemiLight = new THREE.HemisphereLight(
    colors[selectModel],
    0xffffff,
    4.5,
  );
  hemiLight.color.setHSL(0.6, 1, 0.6, THREE.SRGBColorSpace);
  hemiLight.groundColor.setHSL(0.095, 1, 0.75, THREE.SRGBColorSpace);
  hemiLight.position.set(0, 50, 0);
  scene.add(hemiLight);

  const dirLight = new THREE.DirectionalLight(0x00ced1, 2.0);
  dirLight.color.setHSL(0.1, 1, 0.95, THREE.SRGBColorSpace);
  dirLight.position.set(-1, 1.75, 1);
  dirLight.position.multiplyScalar(30);
  scene.add(dirLight);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // 高分屏像素量封顶，防 4~9 倍过载
  container.appendChild(renderer.domElement);

  initComputeRenderer();
  initBirds(birdGeometry);

  // stats.js：右下角 FPS 面板（项目约定）
  stats = new Stats();
  stats.showPanel(0);
  stats.dom.style.position = 'absolute';
  stats.dom.style.left = 'auto';
  stats.dom.style.right = '0';
  stats.dom.style.top = 'auto';
  stats.dom.style.bottom = '0';
  container.appendChild(stats.dom);

  // 交互：鼠标移动 = 鸟群的"猎物"在动
  container.style.touchAction = 'none';
  container.addEventListener('pointermove', onPointerMove);

  onStageResize();
  loop();
}

/* ===================== GPU 计算管线 ===================== */
function initComputeRenderer() {
  gpuCompute = new GPUComputationRenderer(WIDTH, WIDTH, renderer);

  const dtPosition = gpuCompute.createTexture();
  const dtVelocity = gpuCompute.createTexture();
  fillPositionTexture(dtPosition);
  fillVelocityTexture(dtVelocity);

  velocityVariable = gpuCompute.addVariable(
    'textureVelocity',
    velocityFrag,
    dtVelocity,
  );
  positionVariable = gpuCompute.addVariable(
    'texturePosition',
    positionFrag,
    dtPosition,
  );

  // 速度依赖位置+速度，位置依赖位置+速度（互为输入，ping-pong 迭代）
  gpuCompute.setVariableDependencies(velocityVariable, [
    positionVariable,
    velocityVariable,
  ]);
  gpuCompute.setVariableDependencies(positionVariable, [
    positionVariable,
    velocityVariable,
  ]);

  positionUniforms = positionVariable.material.uniforms;
  velocityUniforms = velocityVariable.material.uniforms;

  positionUniforms['time'] = { value: 0.0 };
  positionUniforms['delta'] = { value: 0.0 };
  velocityUniforms['time'] = { value: 1.0 };
  velocityUniforms['delta'] = { value: 0.0 };
  velocityUniforms['testing'] = { value: 1.0 };
  // 官方 GUI 默认项（effectController）via valuesChanger()：分离/对齐/聚集 = 20/20/20，
  // freedom = 0.75 → zoneRadius = 60，三区间各占 1/3。
  // 注意 initComputeRenderer 里的占位 1.0 会被这组值立刻覆盖——这才是真实生效值
  velocityUniforms['separationDistance'] = { value: 20.0 };
  velocityUniforms['alignmentDistance'] = { value: 20.0 };
  velocityUniforms['cohesionDistance'] = { value: 20.0 };
  velocityUniforms['freedomFactor'] = { value: 0.75 };
  velocityUniforms['predator'] = { value: new THREE.Vector3() };
  velocityVariable.material.defines.BOUNDS = BOUNDS.toFixed(2);

  // RepeatWrapping：鸟飞出边界会从另一侧回来
  velocityVariable.wrapS = THREE.RepeatWrapping;
  velocityVariable.wrapT = THREE.RepeatWrapping;
  positionVariable.wrapS = THREE.RepeatWrapping;
  positionVariable.wrapT = THREE.RepeatWrapping;

  const error = gpuCompute.init();
  if (error !== null) console.error(error);
}

/* ===================== 鸟群网格：onBeforeCompile 注入 instancing 逻辑 ===================== */
function initBirds(birdGeometry) {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 1,
    metalness: 0,
  });

  m.onBeforeCompile = (shader) => {
    shader.uniforms.texturePosition = { value: null };
    shader.uniforms.textureVelocity = { value: null };
    shader.uniforms.textureAnimation = { value: textureAnimation };
    shader.uniforms.time = { value: 1.0 };
    shader.uniforms.size = { value: sizes[selectModel] };
    shader.uniforms.delta = { value: 0.0 };

    let token = '#define STANDARD';
    shader.vertexShader = shader.vertexShader.replace(
      token,
      token + '\n' + injectDecl,
    );

    token = '#include <begin_vertex>';
    shader.vertexShader = shader.vertexShader.replace(token, injectTransform);

    materialShader = shader;
  };

  birdMesh = new THREE.Mesh(birdGeometry, m);
  birdMesh.rotation.y = Math.PI / 2;
  birdMesh.frustumCulled = false; // 鸟群整体包围球巨大，剔除不划算且易误剔除
  // 官方 GUI 默认 count = BIRDS/4：模拟全量 4096 只跑，但只绘制 1024 只
  // 官方 GUI 默认 count = BIRDS/4 = 1024 只；卡顿时可再减半（BIRDS / 8）
  birdMesh.geometry.setDrawRange(0, indicesPerBird * (BIRDS / 4));
  scene.add(birdMesh);
}

/* ===================== 模拟纹理初始数据 ===================== */
function fillPositionTexture(texture) {
  const theArray = texture.image.data;

  for (let k = 0, kl = theArray.length; k < kl; k += 4) {
    theArray[k + 0] = Math.random() * BOUNDS - BOUNDS_HALF;
    theArray[k + 1] = Math.random() * BOUNDS - BOUNDS_HALF;
    theArray[k + 2] = Math.random() * BOUNDS - BOUNDS_HALF;
    theArray[k + 3] = 1;
  }
}

function fillVelocityTexture(texture) {
  const theArray = texture.image.data;

  for (let k = 0, kl = theArray.length; k < kl; k += 4) {
    theArray[k + 0] = (Math.random() - 0.5) * 10;
    theArray[k + 1] = (Math.random() - 0.5) * 10;
    theArray[k + 2] = (Math.random() - 0.5) * 10;
    theArray[k + 3] = 1;
  }
}

/* ===================== 交互 / 自适应 ===================== */
function onStageResize() {
  if (!renderer || !stageRef.value) return;
  const rect = stageRef.value.getBoundingClientRect();
  if (rect.width <= 0) return;

  containerHalfX = rect.width / 2;
  containerHalfY = rect.height / 2;
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
  renderer.setSize(rect.width, rect.height);
}

function onPointerMove(event) {
  if (event.isPrimary === false) return;
  lastPointerAt = performance.now(); // 真实输入 → 暂停自动驱鸟
  const rect = renderer.domElement.getBoundingClientRect();
  mouseX = event.clientX - rect.left - containerHalfX;
  mouseY = event.clientY - rect.top - containerHalfY;
}

/* ===================== 渲染循环 ===================== */
function render() {
  const now = performance.now();
  let delta = (now - last) / 1000;
  if (delta > 1) delta = 1; // 后台标签页切回时 delta 巨大，封顶防爆
  last = now;

  positionUniforms['time'].value = now;
  positionUniforms['delta'].value = delta;
  velocityUniforms['time'].value = now;
  velocityUniforms['delta'].value = delta;
  if (materialShader) materialShader.uniforms['time'].value = now / 1000;
  if (materialShader) materialShader.uniforms['delta'].value = delta;

  // predator 归一化到 [-0.5, 0.5]，乘 BOUNDS 得世界坐标；用过一次即重置到远处
  autoPredator(now); // 鼠标静默时由虚拟猎物巡游驱动 mouseX/mouseY
  velocityUniforms['predator'].value.set(
    (0.5 * mouseX) / containerHalfX,
    (-0.5 * mouseY) / containerHalfY,
    0,
  );
  mouseX = 10000;
  mouseY = 10000;

  gpuCompute.compute();

  // 把本轮模拟结果喂给渲染材质
  if (materialShader)
    materialShader.uniforms['texturePosition'].value =
      gpuCompute.getCurrentRenderTarget(positionVariable).texture;
  if (materialShader)
    materialShader.uniforms['textureVelocity'].value =
      gpuCompute.getCurrentRenderTarget(velocityVariable).texture;

  renderer.render(scene, camera);
}

function loop() {
  if (disposed) return;
  rafId = requestAnimationFrame(loop);
  stats.begin();
  stepIntro(performance.now()); // 打字机相位机：并入渲染帧，不再走定时器
  render();
  stats.end();
}

/* ===================== dispose 体系（项目约定） ===================== */
function dispose() {
  if (disposed) return;
  disposed = true;
  cancelAnimationFrame(rafId);
  resizeObserver?.disconnect();
  resizeObserver = null;

  if (stageRef.value)
    stageRef.value.removeEventListener('pointermove', onPointerMove);
  if (stats && stats.dom) stats.dom.remove();

  // GPU 资源逐个释放：鸟群几何 + 材质 + 烘焙纹理 + 模拟纹理
  if (birdMesh) {
    birdMesh.geometry.dispose();
    birdMesh.material.dispose();
  }
  textureAnimation?.dispose();

  // GPUComputationRenderer：模拟用的 renderTarget/材质/初始纹理一并释放
  gpuCompute?.dispose();
  gpuCompute = null;

  if (renderer) {
    renderer.dispose();
    renderer.domElement.remove();
    renderer = null;
  }
  scene = null;
  camera = null;
  materialShader = null;
  birdMesh = null;
  textureAnimation = null;
  stats = null;
  velocityVariable = null;
  positionVariable = null;
  positionUniforms = null;
  velocityUniforms = null;
}

/* ===================== 生命周期 ===================== */
onBeforeUnmount(() => {
  stopIntro();
  if (homeMinTimer) clearTimeout(homeMinTimer);
  homeMinTimer = null;
  dispose();
});
</script>

<style scoped>
/* 全屏舞台：canvas 铺满视口，HUD/加载提示以它为锚点 */
.stage {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}

/* 加载中改用全局 v-loading 指令（白色遮罩 + 转圈圈），此处仅保留错误提示 */

/* 错误提示沿用原胶囊样式 */
.loading-tip {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 20;
  padding: 4px 12px;
  font-size: 11px;
  color: #fff;
  background: rgba(0, 0, 0, 0.5);
  border-radius: 4px;
}

.loading-tip.error {
  background: rgba(226, 72, 61, 0.85);
}

/* ---- 打字机自我介绍 ---- */
.intro {
  position: absolute;
  left: 20%;
  top: 15%;
  max-width: 800px; /* 文本超过即换行 */
  z-index: 10;
  pointer-events: none; /* 纯展示，不挡鼠标驱鸟 */
}

/* 背景做在行内元素上：高亮条只裹住已打出的文字，随打字逐渐变长 */
.intro-text {
  display: inline;
  font-size: 38px; /* 20px × 近两倍 */
  line-height: 1.6;
  color: #fff;
  /* 高亮底直接垫在文字后面，box-decoration-break 保证换行时每行都断开补齐 */
  background: var(--color2);
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
  padding: 2px 10px;
  border-radius: 6px;
}

/* 光标：打字中常亮 */
.cursor {
  color: #fff;
  font-weight: bold;
  margin-left: 4px;
}
</style>
