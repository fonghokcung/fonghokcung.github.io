/* three.js 对象工厂：本页所有「场景图节点」的创建与更新集中于此。
 *   createBackground     自转模式渐变背景（挂相机，亮→暗沿太阳方向）
 *   createSunRaysGroup   canvas 左侧 4 条光线箭头（挂相机，指示阳光传播方向）
 *   updateSunRays        箭头方向/位置刷新（相机投影 + 赤道实测高度）
 *   createEarthMaterial  显示球材质（onBeforeCompile 注入索引→调色板 + 昼夜光照）
 *   createAxisLine       地轴线
 *   createLatitudeCircle 纬线圈（赤道/南北极圈）
 */
import * as THREE from 'three';

const HELPER_COLOR = 0xfbd509; // 地轴/纬圈/箭头色 = --color-primary（#FBD509）

/* —— 渐变背景：全屏平面，uSunScreen（屏幕空间太阳方向）决定渐变方向 —— */
export function createBackground() {
  const mesh = new THREE.Mesh(
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
          vec2 p = vUv * 2.0 - 1.0;                          // uv → NDC [-1,1]
          vec2 s = normalize(uSunScreen);
          float t = clamp(dot(p, s) * -0.5 + 0.5, 0.0, 1.0); // 太阳侧 0 → 背阳侧 1
          float g = mix(200.0, 10.0, t) / 255.0;
          gl_FragColor = vec4(vec3(g), 1.0);
        }
      `,
    }),
  );
  mesh.visible = false; // 默认关：静止态用纯色 scene.background
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return { mesh, sunUniform: mesh.material.uniforms.uSunScreen };
}

/* —— 4 条光线箭头组（挂相机）：ArrowHelper = 线杆 + 锥头 —— */
export function createSunRaysGroup() {
  const group = new THREE.Group();
  const RAY_COUNT = 4;
  for (let i = 0; i < RAY_COUNT; i++) {
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(),
      1,
      HELPER_COLOR,
      0.16,
      0.08,
    );
    arrow.position.set(-0.92, 0.45 - i * 0.3, -1); // 初始占位；updateSunRays 每帧重排
    arrow.renderOrder = 5; // 画在渐变背景之上
    group.add(arrow);
  }
  group.visible = false;
  return group;
}

const rayTmp = new THREE.Vector3();
const perpTmp = new THREE.Vector3();
const centerTmp = new THREE.Vector3();

// 箭头刷新：方向 = 光线传播方向 = 屏幕空间太阳方向的反向；
// 位置中心 y = 0.5 半高（固定值），x 取横向偏移 -0.8 半宽
export function updateSunRays(group, camera, sunUniform) {
  const dir = sunUniform.value;
  const prop = rayTmp.set(-dir.x, -dir.y, 0).normalize();
  const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const halfW = halfH * camera.aspect;
  group.children.forEach((arrow, i) => {
    arrow.setDirection(prop);
    perpTmp.set(-prop.y, prop.x, 0);
    centerTmp
      .set(-0.8 * halfW, 0.5 * halfH, -1)
      .addScaledVector(perpTmp, halfH * (0.33 - i * 0.22));
    arrow.position.copy(centerTmp);
    arrow.setLength(0.09 * halfH, 0.028 * halfH, 0.014 * halfH);
  });
}

/* —— 显示球材质：MeshBasic + onBeforeCompile 注入「索引→调色板」与昼夜光照 —— */
export function createEarthMaterial({
  texture,
  indexTexture,
  paletteTexture,
  paletteWidth,
}) {
  const sunDirVec = new THREE.Vector3(-1, 0, 0); // 占位；startSpin 时按相机屏幕左方重算
  let sunLightUniform = null;
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
    shader.uniforms.paletteTextureWidth = { value: paletteWidth };
    shader.uniforms.uSunDir = { value: sunDirVec };
    shader.uniforms.uLightOn = { value: 0 }; // 默认关：静止态无昼夜
    sunLightUniform = shader.uniforms.uLightOn; // 捕获引用，供自转模式开关
  };
  // 顶点着色器补一段：法线变到世界空间传给片元（MeshBasic 本身不带光照链）
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
  return { material, sunDirVec, getSunLightUniform: () => sunLightUniform };
}

/* —— 地轴线：贯穿南北极延长 35%，常显（自转时随组倾斜） —— */
export function createAxisLine() {
  const pts = [new THREE.Vector3(0, -1.35, 0), new THREE.Vector3(0, 1.35, 0)];
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: HELPER_COLOR }),
  );
}

/* —— 纬线圈：纬度 φ 的圆半径 = cos(φ)，高度 y = sin(φ) —— */
export function createLatitudeCircle(latDeg) {
  const lat = THREE.MathUtils.degToRad(latDeg);
  const r = Math.cos(lat) * 1.005; // 1.005：略大于球面防 z-fighting
  const y = Math.sin(lat);
  const pts = [];
  const SEGMENTS = 128;
  for (let i = 0; i <= SEGMENTS; i++) {
    const a = (i / SEGMENTS) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
  }
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: HELPER_COLOR }),
  );
}
