<template>
  <ThreeLayout ref="layoutRef" @stage-resize="onResize">
    <template #default>
      <h2 class="txt-title">流动水波</h2>
      <p class="txt-sub">
        此页面的水波是「法线假象」：几何上是一块完全平坦的平面，没有任何顶点起伏。
        起伏来自一张噪声烘焙成的法线贴图——可以理解为先用 Perlin
        类噪声生成随机高度场、求导后把法线方向编码进图片。
      </p>
      <p class="txt-sub">
        每一帧用多组不同速度的 UV 偏移重复采样这张贴图，静止的噪声就呈现出流动的
        水面法线；再配合天空环境贴图（PMREM）与菲涅耳反射，远处水天自然相接。
        这比真实位移顶点便宜得多，因此足以覆盖上万单位的海面。
      </p>
      <p class="txt-sub">
        天空里的云层是在片元着色器
        <span class="fbm-tip" tabindex="0">
          ?
          <span class="fbm-tip__popup">
            顶点只搭了个极简天空盒，真正的云形是光栅化之后每个像素独立跑噪声算出来的。
          </span>
        </span>

        中实时计算的：用 Perlin 梯度噪声 生成云的基本密度场，再叠加四倍频 fbm
        <span class="fbm-tip" tabindex="0">
          ?
          <span class="fbm-tip__popup">
            fbm 全称 fractal Brownian
            motion（分形布朗运动），把基础噪声多层叠加的分形组合方法。
          </span>
        </span>
        （振幅减半、频率翻倍） 补出从大云团到细碎边缘的层次。
      </p>
      <a
        class="txt-hint"
        href="/textures/waternormals.jpg"
        target="_blank"
        rel="noopener"
      >
        点击查看法线贴图
      </a>
    </template>

    <template #stage></template>
  </ThreeLayout>
</template>

<script setup>
/* 严格对齐官网 webgl_shaders_ocean，只保留海洋 + 天空/太阳：
 * 删除 Bloom 后期、演示立方体、OrbitControls、Stats、GUI。
 * 参数全部与官网一致：相机 (30,30,100)、太阳高度 2°/方位 180、曝光 0.1、
 * 水色 0x001e0f、distortionScale 3.7、天空 turbidity/rayleigh/mie 与云量等。
 * 唯一适配：ThreeLayout 舞台 + 手动 resize（官网为全屏窗口） */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';
import { Sky } from 'three/addons/objects/Sky.js';
import ThreeLayout from '@/components/ThreeLayout.vue';

const layoutRef = ref(null);

let renderer = null;
let scene = null;
let camera = null;
let water = null;
let sky = null;
let pmremGenerator = null;
let renderTarget = null;
let timer = null;
let disposed = false;

const sun = new THREE.Vector3();
// 与官网完全一致的太阳/曝光参数
const parameters = { elevation: 2, azimuth: 169, exposure: 0.1 };

/* ===================== 初始化 ===================== */
function init() {
  const container = layoutRef.value.stageRef;
  if (!container || disposed) return;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = parameters.exposure;
  renderer.setAnimationLoop(animate);

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(55, 1, 1, 20000);
  camera.position.set(30, 30, 100);

  // —— Water：万级平面 + 噪声法线贴图 ——
  const waterGeometry = new THREE.PlaneGeometry(10000, 10000);
  water = new Water(waterGeometry, {
    textureWidth: 512,
    textureHeight: 512,
    waterNormals: new THREE.TextureLoader().load(
      '/textures/waternormals.jpg',
      (texture) => {
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
      },
    ),
    sunDirection: new THREE.Vector3(),
    sunColor: 0xffffff,
    waterColor: 0x001e0f,
    distortionScale: 3.7,
    fog: scene.fog !== undefined,
  });
  water.rotation.x = -Math.PI / 2;
  scene.add(water);

  // —— Sky：大气散射 + 云层 ——
  sky = new Sky();
  sky.scale.setScalar(10000);
  scene.add(sky);
  const skyUniforms = sky.material.uniforms;
  skyUniforms.turbidity.value = 10;
  skyUniforms.rayleigh.value = 2;
  skyUniforms.mieCoefficient.value = 0.005;
  skyUniforms.mieDirectionalG.value = 0.8;
  skyUniforms.cloudCoverage.value = 0.4;
  skyUniforms.cloudDensity.value = 0.5;
  skyUniforms.cloudElevation.value = 0.5;

  // PMREM：用天空生成环境贴图，水面反射与整体环境光都依赖它
  pmremGenerator = new THREE.PMREMGenerator(renderer);
  const sceneEnv = new THREE.Scene();

  function updateSun() {
    const phi = THREE.MathUtils.degToRad(90 - parameters.elevation);
    const theta = THREE.MathUtils.degToRad(parameters.azimuth);
    sun.setFromSphericalCoords(1, phi, theta);
    sky.material.uniforms.sunPosition.value.copy(sun);
    water.material.uniforms.sunDirection.value.copy(sun).normalize();
    renderTarget?.dispose();
    sceneEnv.add(sky);
    renderTarget = pmremGenerator.fromScene(sceneEnv);
    scene.add(sky);
    scene.environment = renderTarget.texture;
  }
  updateSun();

  timer = new THREE.Timer();
  timer.connect(document);

  onResize();
}

function animate() {
  if (disposed) return;
  timer.update();
  const time = performance.now() * 0.001;
  const delta = timer.getDelta();
  // water 时间驱动法线流动；sky 时间驱动云层漂移（与官网 render 一致）
  water.material.uniforms.time.value += delta;
  sky.material.uniforms.time.value = time;
  renderer.render(scene, camera);
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
  renderTarget?.dispose();
  pmremGenerator?.dispose();
  renderer?.dispose();
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
/* fbm 问号图标 + hover/聚焦 tooltip */
.fbm-tip {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 13px;
  height: 13px;
  margin: 0 2px;
  font-size: 9px;
  color: var(--color3);
  cursor: help;
  border: 1px solid var(--color3);
  border-radius: 50%;
}
.fbm-tip__popup {
  position: absolute;
  top: calc(100% + 6px);
  right: -4px;
  z-index: 50;
  width: 200px;
  padding: 6px 8px;
  font-size: 10px;
  line-height: 1.5;
  color: #fff;
  visibility: hidden;
  background: var(--color3);
  border-radius: 5px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
  opacity: 0;
  transition: opacity 0.15s;
  pointer-events: none;
}
.fbm-tip:hover .fbm-tip__popup,
.fbm-tip:focus .fbm-tip__popup {
  visibility: visible;
  opacity: 1;
}

/* 让链接复用 txt-hint 的分隔线与块级布局，并去掉默认下划线 */
.txt-hint {
  display: block;
  text-decoration: none;
}
.txt-hint:hover {
  text-decoration: underline;
}
</style>
