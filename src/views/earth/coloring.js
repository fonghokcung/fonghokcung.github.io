/* 彩色国家地图：索引贴图当邻接数据库 + 贪心图着色。
 * 原理：把 indexTexture 画到离屏 canvas 读出像素；对每个国家扫一遍贴图，
 * 「本像素 = 该国 且 右/下相邻像素是另一个国家」→ 两国接壤，记入邻接表。
 * 然后 Welsh-Powell 式贪心：按 ID 序每国取「邻国没用过的第一个颜色」。
 *
 * buildCountryColors 为异步（图片 onload），完成后调用 onDone（页面里触发重绘）。
 * 返回 countryColor 数组（每国 → MAP_COLORS 下标），存于闭包供 colorAllCountries 复用。
 */
import { MAP_COLORS, setPaletteColor } from '@/views/earth/palette';

export function createColoring({ indexTextureUrl, palette, onDone }) {
  let countryColor = null;

  function buildCountryColors(countryInfos, paletteTexture) {
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
        setPaletteColor(palette, id, MAP_COLORS[countryColor[id - 1]]);
      }
      paletteTexture.needsUpdate = true;
      onDone();
    };
  }

  // 把所有国家重刷成各自的地图色（初始化与「取消全部选中」共用）；
  // 首次着色未完成时先触发异步构建
  function colorAllCountries(countryInfos, paletteTexture) {
    if (!countryColor) {
      buildCountryColors(countryInfos, paletteTexture);
      return;
    }
    for (let id = 1; id <= countryInfos.length; ++id) {
      setPaletteColor(palette, id, MAP_COLORS[countryColor[id - 1]]);
    }
    paletteTexture.needsUpdate = true;
  }

  // 取某国当前颜色下标（点选取消时还原用）；未着色完为 undefined
  const getCountryColor = (id) => countryColor?.[id - 1];

  return { colorAllCountries, getCountryColor };
}
