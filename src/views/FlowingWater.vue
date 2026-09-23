<template>
  <ThreeLayout ref="layoutRef" @stage-resize="onResize">
    <template #default>
      <h2 class="txt-title">海洋</h2>
      <p class="txt-sub">
        three.js 官网 webgl_shaders_ocean：WebGLRenderer + Water（传统
        GLSL，法线贴图流动 + 镜面反射）+ Sky（大气散射 + 云层）。
      </p>
      <p class="txt-sub">
        波浪不是顶点位移，而是一张平铺的法线贴图，每帧用多组不同速度的 UV
        偏移重复采样得到起伏法线；水面颜色来自天空环境贴图（PMREM）与
        菲涅耳反射，远处和天空自然相接。
      </p>
      <p class="txt-hint">固定机位 · 无需操作</p>
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
/* ThreeLayout 已提供舞台；本页无额外悬浮层 */
</style>
