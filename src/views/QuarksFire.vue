<template>
  <ThreeLayout
    class="QuarksFire__vue"
    ref="layoutRef"
    txt-title="Quarks 火焰"
    txt-sub="three.quarks 是 three.js 生态的通用粒子系统库（Unreal Niagara 风格），本页用它搭出一堆篝火。"
    txt-hint="左键拖拽旋转 · 滚轮缩放 · 右下滑杆实时调参"
    @stage-resize="onResize"
  >
    <template #default>
      <p class="txt-sub">
        一团火被拆成三个ParticleSystem叠在一起：主火（橙红大骨架）、内焰（亮黄短命芯）、火星（高速上飘的小亮点）。
        三者共用同一个BatchedRenderer，同材质的粒子合并成一个批次绘制，draw call
        不随粒子数增长。
      </p>
      <p class="txt-sub">形态全靠「发射形状 + 生命周期行为」声明式拼装：</p>
      <p class="txt-sub">
        · ConeEmitter 圆盘锥形发射，粒子出生在火盆口一圈，初速朝上（发射器绕 X
        轴旋转 90° 把锥口对准 +Y）；
        <br />· ColorOverLife + Gradient
        按寿命插值颜色——白黄→橙→红→暗红，加色混合下正是火的观感； <br />·
        SizeOverLife + PiecewiseBezier 让火苗「小→鼓→收」，形成舌头形状；
        <br />· TurbulenceField 用 4D 单纯形噪声扰动速度，火舌因此摇曳； <br />·
        ApplyForce 恒定风力，把火焰吹歪。
      </p>
      <p class="txt-sub">
        贴图只有一张 128×128 的径向渐变（离屏 canvas 现画），加色混合 +
        深背景，配上随时间闪烁的橙色点光源，氛围就齐了。
      </p>
      <p class="txt-hint">
        粒子系统 = 发射器 + 行为列表，参数改在行为上，火焰立刻换性格
      </p>
    </template>

    <template #stage>
      <div class="panel">
        <label v-for="row in PANEL" :key="row.key" class="row">
          <span class="name">{{ row.name }}</span>
          <input
            type="range"
            :min="row.min"
            :max="row.max"
            :step="row.step"
            :value="params[row.key]"
            @input="
              params[row.key] = +$event.target.value;
              applyParams();
            "
          />
          <span class="val">{{ params[row.key] }}</span>
        </label>
      </div>
    </template>
  </ThreeLayout>
</template>

<script setup>
/* Quarks 火焰页：three.quarks 声明式粒子系统演示。
 * 三个 ParticleSystem（主火/内焰/火星）共用一个 BatchedRenderer，
 * 滑杆直接改写运行中系统的 public 字段（startSpeed/emissionOverTime/behavior 参数），无需重建。 */
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import ThreeLayout from '@/components/ThreeLayout.vue';
import {
  ApplyForce,
  BatchedRenderer,
  Bezier,
  ColorOverLife,
  ConeEmitter,
  ConstantColor,
  ConstantValue,
  Gradient,
  IntervalValue,
  ParticleSystem,
  PiecewiseBezier,
  RenderMode,
  SizeOverLife,
  TurbulenceField,
} from 'three.quarks';

const layoutRef = ref(null);

/* ---------- 滑杆参数（默认值 = 调好的篝火基准） ---------- */
const params = reactive({
  rate: 100,
  speed: 1.5,
  wind: 0.5,
  turbulence: 0.5,
  size: 0.7,
});
const PANEL = [
  { key: 'rate', name: '发射率', min: 20, max: 300, step: 5 },
  { key: 'speed', name: '火势', min: 0.4, max: 2.5, step: 0.05 },
  { key: 'size', name: '火苗', min: 0.2, max: 1.5, step: 0.05 },
  { key: 'turbulence', name: '湍流', min: 0, max: 1.5, step: 0.05 },
  { key: 'wind', name: '风', min: 0, max: 3, step: 0.05 },
];

/* ---------- three.js 三件套 ---------- */
let renderer, scene, camera, controls, batchedRenderer, fireLight;
let rafId = 0;
const clock = new THREE.Clock();
/* 滑杆要热改的对象引用（buildFlames 里填充） */
const linked = { mains: [], flames: [] };

/* ---------- 火焰贴图：离屏 canvas 画径向渐变，中心实、边缘透 ---------- */
function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ---------- 组装一层火焰 ----------
 * speedScale/sizeScale：内焰、火星在主火参数基础上做倍率
 * 返回 { system, wind, turb } 供滑杆热改 */
function buildFlame(tex, opt) {
  /* 湍流：4D 单纯形噪声逐帧给粒子速度加抖动，octaves=2 叠两层频率 */
  const turb = new TurbulenceField(
    new THREE.Vector3(0.45, 0.45, 0.45), // 噪声空间缩放（越小频率越高）
    2, // octaves
    new THREE.Vector3(opt.turb, opt.turb, opt.turb), // 速度倍率（湍流强度）
    new THREE.Vector3(1, 0.7, 1), // 噪声时间流速
  );
  /* 恒定风力，方向 +X（发射器绕 X 转 90° 不影响 X 轴） */
  const wind = new ApplyForce(
    new THREE.Vector3(1, 0, 0),
    new ConstantValue(params.wind),
  );

  const system = new ParticleSystem({
    duration: 2,
    looping: true,
    prewarm: true, // 首帧预演一个周期，开场即是燃烧中
    /* 锥形发射：底盘半径 0.35 的圆盘出生，angle 控制锥口外扩；
     * emitter 默认朝局部 +Z 喷，外层再绕 X 轴 -90° 转成朝上 */
    shape: new ConeEmitter({ radius: opt.radius, angle: 0.2, thickness: 1 }),
    startLife: new IntervalValue(opt.life[0], opt.life[1]),
    /* 基础速度区间 [0.8,1.4]（与 applyParams 的 SPD 一致）× 层倍率 */
    startSpeed: new IntervalValue(0.8 * opt.speedScale, 1.4 * opt.speedScale),
    startSize: new IntervalValue(0.5 * opt.sizeScale, 0.9 * opt.sizeScale),
    startRotation: new IntervalValue(0, Math.PI * 2), // 出生随机朝向
    startColor: new ConstantColor(new THREE.Vector4(1, 1, 1, 1)),
    emissionOverTime: new ConstantValue(opt.rateScale * params.rate),
    renderMode: RenderMode.BillBoard,
    material: new THREE.MeshBasicMaterial({
      map: tex,
      blending: THREE.AdditiveBlending, // 加色：越叠越亮，正是火
      transparent: true,
      depthWrite: false,
    }),
    behaviors: [
      /* 颜色生命周期：主火 白黄→橙→红→暗红；内焰偏白亮；火星橙→红 */
      new ColorOverLife(
        new Gradient(
          opt.colors.map(([r, g, b, t]) => [new THREE.Vector3(r, g, b), t]),
          opt.alpha,
        ),
      ),
      /* 尺寸生命周期：贝塞尔曲线 小→鼓→收，捏出火舌 */
      new SizeOverLife(
        new PiecewiseBezier([
          [
            new Bezier(opt.sizeCurve[0], opt.sizeCurve[1], opt.sizeCurve[2], 0),
            0,
          ],
        ]),
      ),
      turb,
      wind,
    ],
  });
  system.emitter.rotation.x = -Math.PI / 2; // 锥口对准 +Y
  return { system, wind, turb };
}

/* ---------- 三层火焰 ---------- */
function buildFlames(tex) {
  const flameGroup = new THREE.Group();
  flameGroup.position.y = 0.24; // 火盆口

  /* 各层配置：颜色梯度 / alpha 梯度 / 尺寸曲线 / 寿命 / 倍率 */
  const defs = [
    {
      // 主火：大骨架
      radius: 0.32,
      life: [0.7, 1.1],
      speedScale: 1,
      sizeScale: 1,
      rateScale: 1,
      colors: [
        [1.0, 0.95, 0.55, 0],
        [1.0, 0.6, 0.15, 0.25],
        [0.9, 0.25, 0.05, 0.6],
        [0.35, 0.03, 0.01, 1],
      ],
      alpha: [
        [1, 0],
        [1, 0.2],
        [0.9, 0.6],
        [0, 1],
      ],
      sizeCurve: [0.35, 1.3, 0.7], // 小→鼓→收
    },
    {
      // 内焰：短命亮芯
      radius: 0.18,
      life: [0.35, 0.6],
      speedScale: 1.25,
      sizeScale: 0.45,
      rateScale: 0.6,
      colors: [
        [1, 1, 0.85, 0],
        [1, 0.8, 0.4, 0.5],
        [1, 0.5, 0.1, 1],
      ],
      alpha: [
        [1, 0],
        [1, 0.5],
        [0, 1],
      ],
      sizeCurve: [0.5, 1.2, 0.6],
    },
    {
      // 火星：高速小亮点，飘得高
      radius: 0.25,
      life: [1.0, 1.8],
      speedScale: 1.9,
      sizeScale: 0.09,
      rateScale: 0.15,
      colors: [
        [1, 0.8, 0.4, 0],
        [1, 0.2, 0.05, 1],
      ],
      alpha: [
        [1, 0],
        [1, 0.7],
        [0, 1],
      ],
      sizeCurve: [1, 0.8, 0.3], // 越烧越小
    },
  ];

  defs.forEach((opt) => {
    const { system, wind, turb } = buildFlame(tex, opt);
    flameGroup.add(system.emitter);
    batchedRenderer.addSystem(system);
    linked.mains.push(system);
    linked.flames.push({ wind, turb });
  });
  scene.add(flameGroup);
}

/* ---------- 滑杆 → 运行中系统热改（无需重建） ---------- */
function applyParams() {
  /* 发射率：主火 1x / 内焰 0.6x / 火星 0.15x（与 buildFlames 的 rateScale 一致） */
  linked.mains[0].emissionOverTime = new ConstantValue(params.rate);
  linked.mains[1].emissionOverTime = new ConstantValue(params.rate * 0.6);
  linked.mains[2].emissionOverTime = new ConstantValue(params.rate * 0.15);
  /* 火势与火苗：各层基准区间 × 滑杆倍率 */
  const SPD = [
    [0.8, 1.4],
    [0.8, 1.4],
    [0.8, 1.4],
  ];
  linked.mains.forEach((ps, i) => {
    const sc = [1, 1.25, 1.9][i];
    ps.startSpeed = new IntervalValue(
      SPD[i][0] * sc * params.speed,
      SPD[i][1] * sc * params.speed,
    );
    ps.startSize = new IntervalValue(
      [0.5, 0.5, 0.5][i] * [1, 0.45, 0.09][i] * params.size,
      [0.9, 0.9, 0.9][i] * [1, 0.45, 0.09][i] * params.size,
    );
  });
  /* 湍流与风：直接改 behavior 的 public 字段 */
  linked.flames.forEach(({ turb, wind }, i) => {
    const k = [1, 1.2, 1.8][i];
    turb.velocityMultiplier.set(
      params.turbulence * k,
      params.turbulence * k,
      params.turbulence * k,
    );
    wind.magnitude = new ConstantValue(params.wind);
  });
}

/* ---------- 场景搭建 ---------- */
function initScene(container) {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0906); // 深棕黑，衬托加色火焰

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(2.2, 1.5, 2.6);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.6, 0);
  controls.enableDamping = true;

  /* 粒子批次渲染器：同材质系统合并批次 */
  batchedRenderer = new BatchedRenderer();
  scene.add(batchedRenderer);

  /* 地面 + 火盆（暗色道具，不抢戏） */
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(6, 48),
    new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  /* 一小堆木柴：放射状斜搭的篝火柴堆——低端着地、高端聚向火心。
   * 长度/粗细/仰角/朝向全带随机，再垫两根近平躺的柴，堆得随意 */
  const woodMats = [
    new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.95 }),
    new THREE.MeshStandardMaterial({ color: 0x54381f, roughness: 0.95 }),
  ];
  const logs = [];
  for (let i = 0; i < 7; i++) {
    logs.push({
      len: 1.0 + Math.random() * 0.4, // 1.0~1.4
      r: 0.06 + Math.random() * 0.03, // 0.06~0.09
      yaw: (i / 7) * Math.PI * 2 + (Math.random() - 0.5) * 0.9, // 大致均匀 + 随机扰动
      tilt: 0.24 + Math.random() * 0.16, // 仰角 0.24~0.40 rad
      e: 0.05 + Math.random() * 0.12, // 顶端离火心的距离
      mat: woodMats[i % 2],
    });
  }
  /* 垫底的两根近平躺柴，压住堆脚 */
  logs.push({
    len: 1.2,
    r: 0.065,
    yaw: Math.random() * Math.PI,
    tilt: 0.05,
    e: 0.15,
    mat: woodMats[0],
  });
  logs.push({
    len: 1.1,
    r: 0.065,
    yaw: Math.random() * Math.PI,
    tilt: 0.04,
    e: 0.15,
    mat: woodMats[1],
  });

  for (const w of logs) {
    const log = new THREE.Mesh(
      new THREE.CylinderGeometry(w.r, w.r * 0.9, w.len, 12),
      w.mat,
    );
    /* 欧拉 YXZ：先绕 Z 把竖直圆柱放平并抬起仰角 tilt，再绕 Y 转到 yaw 方向。
     * 轴向 A = (-cosT·cosY, sinT, cosT·sinY)：水平分量沿 H，垂直分量 sinT */
    log.rotation.order = 'YXZ';
    log.rotation.set(0, w.yaw, Math.PI / 2 - w.tilt);
    /* 摆位解算：让底端恰好触地（y=0）、顶端落在离火心 e 处 */
    const H = new THREE.Vector3(-Math.cos(w.yaw), 0, Math.sin(w.yaw)); // 轴向的水平单位分量
    const P = new THREE.Vector3(Math.sin(w.yaw), 0, Math.cos(w.yaw)); // H 的水平垂直方向
    log.position
      .copy(H)
      .multiplyScalar(w.e - (w.len / 2) * Math.cos(w.tilt))
      .addScaledVector(P, (Math.random() - 0.5) * 0.16); // 侧向随机散开，更像随手堆的
    log.position.y = (w.len / 2) * Math.sin(w.tilt) + w.r * Math.cos(w.tilt);
    scene.add(log);
  }

  /* 灯光：弱环境 + 随火焰闪烁的橙色点光 */
  scene.add(new THREE.HemisphereLight(0x554433, 0x080810, 0.8));
  fireLight = new THREE.PointLight(0xff7722, 0, 9, 1.6);
  fireLight.position.set(0, 0.7, 0);
  scene.add(fireLight);
  /* 月光补一盏方向光，勾出木柴轮廓，避免纯黑剪影 */
  const moon = new THREE.DirectionalLight(0xefefef, 2);
  moon.position.set(-2, 3, -1.5);
  scene.add(moon);

  buildFlames(makeGlowTexture());
  applyParams();
}

function onResize(rect) {
  if (!renderer) return;
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
  renderer.setSize(rect.width, rect.height);
}

function tick() {
  rafId = requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  batchedRenderer.update(dt); // 驱动所有粒子系统模拟 + 批次更新
  /* 点光随火苗抖动：两个不同频率正弦叠加模拟闪烁 */
  fireLight.intensity =
    2.4 + Math.sin(t * 11) * 0.5 + Math.sin(t * 23 + 1.7) * 0.35;

  controls.update();
  renderer.render(scene, camera);
}

onMounted(() => {
  initScene(layoutRef.value.stageRef);
  onResize(layoutRef.value.stageRef.getBoundingClientRect());
  tick();
});

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId);
  controls?.dispose();
  linked.mains.forEach((ps) => ps.dispose());
  renderer?.dispose();
  renderer?.domElement.remove();
});
</script>

<style scoped>
/* 调参面板：悬浮在舞台右下角 */
.panel {
  position: absolute;
  right: 12px;
  bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  background: rgba(10, 8, 6, 0.72);
  border: 1px solid rgba(255, 150, 50, 0.25);
  border-radius: 8px;
  backdrop-filter: blur(4px);
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: #e8c9a0;
}
.row .name {
  width: 38px;
  text-align: right;
}
.row .val {
  width: 30px;
  color: #ffae5c;
}
.row input[type='range'] {
  width: 110px;
  accent-color: #ff8830;
}
</style>
