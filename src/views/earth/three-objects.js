/* three.js 对象工厂：本页所有「场景图节点」的创建与更新集中于此。
 *   createBackground     星空背景（挂相机，深空底色 + 程序化星点，常显）
 *   createSunRaysGroup   4 条光线箭头（世界空间，随公转角度绕 Y 定位，指示阳光传播方向）
 *   updateSunRays        箭头方向/位置刷新（世界空间，随公转角度绕 Y 定位）
 *   createEarthMaterial  显示球材质（onBeforeCompile 注入索引→调色板 + 昼夜光照）
 *   createAxisLine       地轴线
 *   createLatitudeCircle 纬线圈（赤道/南北极圈）
 */
import * as THREE from 'three';

const HELPER_COLOR = 0xfbd509; // 地轴/纬圈/箭头色 = --color-primary（#FBD509）

/* —— 星空背景：全屏平面挂相机（固定屏幕空间），深空底色 + 两层程序化星点，仅自转模式显示 —— */
export function createBackground() {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: { uAspect: { value: 1 } }, // 屏幕宽高比：星点不被拉扁（onResize 时更新）
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy * 2.0, 0.9999, 1.0); // ±0.5 → ±1(NDC)：铺满屏幕
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform float uAspect;

        // 二维 hash → [0,1) 伪随机
        float hash21(vec2 p) {
          p = fract(p * vec2(234.34, 435.345));
          p += dot(p, p + 34.23);
          return fract(p.x * p.y);
        }

        void main() {
          vec2 p = vUv * 2.0 - 1.0; // uv → NDC [-1,1]
          p.x *= uAspect;
          vec3 col = vec3(0.012, 0.016, 0.030); // 深空底色：近黑微蓝
          // 两层星点：稀疏亮星 + 密集暗星，制造景深
          for (int layer = 0; layer < 2; layer++) {
            float fl = float(layer);
            vec2 g = p * mix(14.0, 42.0, fl);   // 网格密度
            vec2 id = floor(g) + fl * 61.7;     // 层间错开
            vec2 f = fract(g);
            float has = step(mix(0.80, 0.93, fl), hash21(id)); // 只部分格子有星
            vec2 starPos = vec2(hash21(id + 1.3), hash21(id + 2.7)); // 格内随机
            float star = smoothstep(0.12, 0.02, length(f - starPos)) * has;
            star *= 0.3 + 0.7 * hash21(id + 4.1); // 亮度随机
            // 冷暖随机（偏蓝白 / 偏暖黄）
            col += star * mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.88, 0.70),
                              hash21(id + 5.9));
          }
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );
  mesh.visible = false; // 默认关：静止态用纯色 scene.background
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return { mesh, aspectUniform: mesh.material.uniforms.uAspect };
}

/* —— 4 条光线箭头组（世界空间）：ArrowHelper = 线杆 + 锥头 —— */
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
    arrow.position.set(2, 0.45 - i * 0.3, 0); // 初始占位；updateSunRays 按日期重排
    group.add(arrow);
  }
  group.visible = false;
  return group;
}

const rayTmp = new THREE.Vector3();
const centerTmp = new THREE.Vector3();

// 箭头刷新（世界空间）：锚点 = 太阳方向 × 半径（绕 Y 轴随日期转动），
// 方向 = 光线传播方向 = 指向地心；4 条沿 Y 轴错开（光都在 xoz 平面内，Y 即垂直方向）
export function updateSunRays(group, sunDir) {
  const RADIUS = 1.9; // 距地心（地球半径 1，相机距离 2.5，落在其间）
  const prop = rayTmp.copy(sunDir).negate().normalize();
  group.children.forEach((arrow, i) => {
    arrow.setDirection(prop);
    centerTmp.copy(sunDir).multiplyScalar(RADIUS);
    centerTmp.y += 0.45 - i * 0.3;
    arrow.position.copy(centerTmp);
    arrow.setLength(0.5, 0.12, 0.06);
  });
}

/* —— 显示球材质：MeshBasic + onBeforeCompile 注入「索引→调色板」与昼夜光照 —— */
export function createEarthMaterial({
  texture,
  indexTexture,
  paletteTexture,
  paletteWidth,
}) {
  const sunDirVec = new THREE.Vector3(-1, 0, 0); // 占位；startSpin 时按相机屏幕右方重算
  let sunLightUniform = null;
  let lightOn = 0; // 期望的开关状态：onBeforeCompile 尚未触发时先记下，编译时用作初值
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
    shader.uniforms.uLightOn = { value: lightOn }; // 初值取期望状态（编译晚于 startSpin 时也正确）
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
  return {
    material,
    sunDirVec,
    // 开关昼夜光照：着色器编译前调用也安全（初值由 lightOn 提供）
    setSunLight: (on) => {
      lightOn = on ? 1 : 0;
      if (sunLightUniform) sunLightUniform.value = lightOn;
    },
  };
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
