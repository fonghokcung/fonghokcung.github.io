<template>
  <ThreeLayout class="NoiSe__vue" ref="layoutRef" @stage-resize="onResize">
    <template #default>
      <h2 class="txt-title">噪声山脉</h2>

      <p class="txt-sub">
        柏林噪声（Perlin Noise） 是一种由 Ken Perlin 在 1983
        年发明的梯度噪声算法。
      </p>
      <p class="txt-sub">
        为什么需要柏林噪声呢？我们首先得说说纯随机噪声，纯随机噪声是每个像素点独立随机取值，结果像电视雪花，毫无规律。这种噪声没有空间连贯性，不适合模拟自然现象。而柏林噪声的核心目标是相邻点的值应该相近，整体平滑连续，但又带有随机性。
      </p>
      <div class="pipeline-note">
        <p class="txt-sub">
          本示例更好的做法是游戏/影视行业的标准内容管线——离线烘焙，运行时播放，
          「两山之间」的飞行效果在这条管线里几乎是必然的。
        </p>
        <p class="txt-sub">
          1. 地形生成：Gaea / World Machine / Houdini / World Creator（Blender
          亦可）用 Perlin 节点 + 水力侵蚀生成，烤死成高度图、纹理与网格；
        </p>
        <p class="txt-sub">
          2.
          路径调整：在能看见地形全貌的样条编辑器里，手工把曲线从两座山峰之间拖过去，
          并加关键帧控制高低与速度；
        </p>
        <p class="txt-sub">
          3. 导出载入：GLTF 模型 + 曲线控制点 JSON，运行时只读——不再计算噪声，
          也就没有一致性负担和路径被架高的问题。
        </p>
        <p class="txt-sub">
          关键区别是 bake-time 与
          runtime，而非程序化与手工：三维软件里同样是程序化生成，
          只在制作期烘焙。侵蚀模拟计算量大、必须离线，它产生的才是真实山脉的分水岭与山谷；
          原始 Perlin/fBm 本质只是「起伏的泡泡」。
        </p>
      </div>
      <p class="txt-sub">
        当前页面采用运行时程序化：零资产、每次刷新地形不同，代价是美学质量靠运气、
        安全靠收敛器。折中方案是地形离线烘焙、路径在导出的高度图上运行时搜索，
        兼顾真实山形与路径随机性。
      </p>
      <p class="txt-hint">质量上限在离线管线 · 灵活性在运行时管线</p>
    </template>

    <template #stage>
      <button class="overview-btn overlay-corner" @click="toggleMode">
        {{ isFlying ? '全貌' : '返回飞行' }}
      </button>
    </template>
  </ThreeLayout>
</template>

<script setup>
/* 噪声山脉页面：顶点着色器用经典 Perlin 2D + fBm 生成地形，
 * 相机沿预生成闭合路径自动巡航（fly-camera.js）。
 * 两种模式：飞行（默认）/ 全貌（OrbitControls 俯瞰，路径曲线同步显隐） */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import ThreeLayout from '@/components/ThreeLayout.vue';
import noiseTerrainVert from '@/shaders/noise-terrain.vert?raw';
import noiseTerrainFrag from '@/shaders/noise-terrain.frag?raw';
import {
  buildFlightPath,
  CLEARANCE,
  FlyCamera,
  PERM,
  terrainHeight,
} from '@/views/noise/fly-camera';

const layoutRef = ref(null);
const isFlying = ref(true); // true=飞行模式（默认）；false=全貌模式

let renderer = null;
let scene = null;
let camera = null;
let material = null;
let flyCamera = null; // 路径飞行控制器
let controls = null; // 全貌模式的轨道控制器
let terrain = null; // 地形 mesh
let pathHelpers = []; // 路径可视化对象（仅全貌模式可见）
let rafId = 0;
let disposed = false;

/* ===================== 初始化 ===================== */
function init() {
  const container = layoutRef.value.stageRef;
  if (!container || disposed) return;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  // 雾色 = 天空色：远处地形淡入天空，看不到地形边界
  const skyColor = new THREE.Color('#0d1b2a');
  scene.background = skyColor;
  scene.fog = new THREE.Fog(skyColor, 3.2, 7.2); // 数值与片元距离雾一致

  // 直升机照明（地形走自定义 shader 不吃场景灯）：
  // 主光 + 半球环境光 + 反向冷色补光（消除背阴面死黑）
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x2a2f1d, 1.8));
  const sun = new THREE.DirectionalLight(0xfff2d6, 3.5);
  sun.position.set(0.5, 0.8, 0.6);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x9db8ff, 0.9);
  fill.position.set(-0.6, 0.4, -0.5);
  scene.add(fill);

  camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
  const flightPath = buildFlightPath(4.2);
  flyCamera = new FlyCamera(camera, flightPath);
  loadHelicopter();

  material = new THREE.ShaderMaterial({
    vertexShader: noiseTerrainVert,
    fragmentShader: noiseTerrainFrag,
    wireframe: true, // 线框模式；恢复实体着色删掉本行
    uniforms: {
      u_time: { value: 0 },
      uPerm: { value: PERM }, // 置换表：CPU/GPU 共享，地形逐点一致
      uSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.6).normalize() },
      uFogColor: { value: skyColor },
      uFogNear: { value: 3.2 },
      uFogFar: { value: 7.2 },
    },
  });

  // 20 宽地形，512 分段：顶点间距须小于 fBm 最高倍频波长，否则混叠出棱角
  const geo = new THREE.PlaneGeometry(20, 20, 512, 512);
  terrain = new THREE.Mesh(geo, material);
  terrain.rotation.x = -Math.PI / 2; // PlaneGeometry 默认在 xy 平面，旋转平放
  scene.add(terrain);

  // 路径可视化：默认飞行模式隐藏，全貌模式显示
  pathHelpers = debugPathHelper(flightPath);
  for (const obj of pathHelpers) obj.visible = false;

  onResize();
  window.addEventListener('resize', onResize);
  startLoop();
}

/* ===================== 直升机模型加载 =====================
 * 加载后按包围盒自动归一尺寸（目标机长 0.6，不依赖模型原始单位），
 * 并把模型几何中心平移到原点——外层 group 的原点即路径点。
 * 只在飞行模式可见；加载失败静默退化为第一人称 */
const TARGET_HELI_SIZE = 0.4;
function loadHelicopter() {
  new GLTFLoader().load(
    `${import.meta.env.BASE_URL}models/helicopter.glb`,
    (gltf) => {
      if (disposed) return;
      const heli = gltf.scene;
      // FBX 转出的主材质基色被压成近黑（0.012,0.002,0.003），提亮才能显出红色机身
      heli.traverse((obj) => {
        if (!obj.isMesh) return;
        const c = obj.material.color;
        if (c.r + c.g + c.b < 0.05) c.multiplyScalar(30);
        // 降低金属度：金属靠环境贴图反射（本场景无 env map）会发暗、不吃灯；
        // 降到 0.15 让漫反射主导，光照影响才明显
        obj.material.metalness = 0.15;
        // 隐藏模型自带的螺旋桨（扁平宽片 primitive，材质 Material.002），
        // 改用下方自建、可旋转的旋翼
        if (obj.material.name === 'Material.002') obj.visible = false;
      });
      const box = new THREE.Box3().setFromObject(heli);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      const scale = TARGET_HELI_SIZE / Math.max(size.x, size.y, size.z);
      // heli 自身带缩放：几何中心在 group 空间的位置是 scale×center，
      // 故回移量 = −scale×center 才能让 group 原点落在几何中心
      heli.scale.setScalar(scale);
      heli.position.copy(center).multiplyScalar(-scale);
      const group = new THREE.Group();
      group.add(heli);

      // 主旋翼：glb 只有一个整体 mesh（螺旋桨非独立部件），用两片十字薄片自建。
      // group 单位是世界空间：旋翼高度 = 缩放后包围盒顶部
      const topY = size.y * scale * 0.5;
      const bladeGeo = new THREE.BoxGeometry(
        TARGET_HELI_SIZE * 0.92,
        0.004,
        0.025,
      );
      const rotor = new THREE.Group();
      rotor.position.y = topY + 0.02;
      const bladeA = new THREE.Mesh(
        bladeGeo,
        new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7 }),
      );
      const bladeB = bladeA.clone();
      bladeB.rotation.y = Math.PI / 2;
      rotor.add(bladeA, bladeB);
      group.add(rotor);

      group.visible = isFlying.value;
      scene.add(group);
      flyCamera.model = group;
      flyCamera.rotor = rotor;
    },
    undefined,
    (err) => console.error('[helicopter] 加载失败', err),
  );
}

/* ===================== 路径可视化 + 碰撞统计 =====================
 * 黄线 = 路径；路径点低于「地形+净空」处画红色垂线并计数。
 * 返回创建的对象数组，由模式切换控制显隐 */
function debugPathHelper(curve) {
  const helpers = [];
  const SEGMENTS = 400;
  const positions = [];
  const hitPositions = [];
  let hits = 0;
  for (let i = 0; i <= SEGMENTS; i++) {
    const p = curve.getPointAt(i / SEGMENTS);
    positions.push(p.x, p.y, p.z);
    const ground = terrainHeight(p.x, p.z);
    if (p.y < ground + CLEARANCE) {
      hits++;
      hitPositions.push(p.x, p.y, p.z, p.x, ground, p.z);
    }
  }
  const pathLine = new THREE.Line(
    new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.Float32BufferAttribute(positions, 3),
    ),
    new THREE.LineBasicMaterial({ color: 0xfbd509 }),
  );
  scene.add(pathLine);
  helpers.push(pathLine);
  if (hitPositions.length) {
    const hitLine = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute(hitPositions, 3),
      ),
      new THREE.LineBasicMaterial({ color: 0xff2020 }),
    );
    scene.add(hitLine);
    helpers.push(hitLine);
  }
  console.log(
    `[flight-path] 采样 ${SEGMENTS + 1} 点，撞山嫌疑 ${hits} 处` +
      (hits ? '（红线=路径到地面的垂线）' : '（路径安全）'),
  );
  return helpers;
}

/* ===================== 模式切换：飞行 ⇄ 全貌 ===================== */
function toggleMode() {
  if (!renderer) return;
  isFlying.value = !isFlying.value;
  if (isFlying.value) {
    // 回飞行：controls 销毁，下一帧 flyCamera.update 把相机拉回路径当前点
    controls?.dispose();
    controls = null;
  } else {
    // 进全貌：拉高俯瞰，启用 controls
    camera.position.set(0, 12, 13);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.update();
  }
  // 雾程：飞行 3.2~7.2；全貌 100~200（实际关雾）
  const near = isFlying.value ? 3.2 : 100;
  const far = isFlying.value ? 7.2 : 200;
  scene.fog.near = near;
  scene.fog.far = far;
  material.uniforms.uFogNear.value = near;
  material.uniforms.uFogFar.value = far;
  for (const obj of pathHelpers) obj.visible = !isFlying.value;
  // 直升机：仅飞行模式显示（全貌模式观察的是路径与地形）
  if (flyCamera?.model) flyCamera.model.visible = isFlying.value;
}

/* ===================== 渲染循环 ===================== */
function startLoop() {
  const timer = new THREE.Timer();
  timer.connect(document);
  function loop() {
    rafId = requestAnimationFrame(loop);
    if (disposed) {
      timer.disconnect();
      return;
    }
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.05); // 切后台再回来防爆发
    if (isFlying.value) flyCamera?.update(dt);
    renderer.render(scene, camera);
  }
  loop();
}

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
  if (disposed) return;
  disposed = true;
  cancelAnimationFrame(rafId);
  window.removeEventListener('resize', onResize);
  terrain?.geometry.dispose();
  material?.dispose();
  controls?.dispose();
  renderer?.dispose();
  renderer?.domElement.remove();
  renderer = null;
  scene = null;
  camera = null;
}

onMounted(() => {
  init();
});

onBeforeUnmount(() => {
  dispose();
});
</script>

<style scoped>
.pipeline-note p {
  font-style: italic;
}
.overview-btn {
  z-index: 10;
  padding: 7px 16px;
  font-size: 13px;
  color: #e6edf3;
  cursor: pointer;
  background: rgba(20, 30, 45, 0.72);
  border: 1px solid rgba(230, 237, 243, 0.3);
  border-radius: 6px;
  backdrop-filter: blur(4px);
}
.overview-btn:hover {
  background: rgba(40, 55, 75, 0.9);
}
</style>
