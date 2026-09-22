/* 调色板：尺寸/颜色常量 + DataTexture 创建与单格写入 */
import * as THREE from 'three';

const MAX_NUM_COUNTRIES = 512;
export const PALETTE_W = MAX_NUM_COUNTRIES;
export const PALETTE_H = 1;

// 选中色与项目辅色一致：--color2 = hsl(212 100% 62%) = #3D94FF
export const SELECTED_COLOR = [61, 148, 255, 255];
export const OCEAN_COLOR = [100, 200, 255, 255];
// 地图五色板（ColorBrewer 低饱和风格）：四色定理保证平面地图 4 色必够让相邻国不同色，
// 留 1 色余量对抗索引贴图边缘抗锯齿产生的「假邻接」
export const MAP_COLORS = [
  [166, 206, 227, 255],
  [178, 223, 138, 255],
  [253, 191, 111, 255],
  [202, 178, 214, 255],
  [255, 255, 153, 255],
];

// 创建调色板：Uint8Array + 绑着它的 512×1 DataTexture。
// GPU 里国家高亮只改这张 2KB 小纹理，不重传任何几何/贴图 —— 本案例精髓
export function createPaletteTexture() {
  const array = new Uint8Array(PALETTE_W * 4);
  const texture = new THREE.DataTexture(array, PALETTE_W, PALETTE_H);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { array, texture };
}

export function setPaletteColor(palette, index, color) {
  palette.set(color, index * 4);
}
