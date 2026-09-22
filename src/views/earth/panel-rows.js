/* 国家信息面板的行定义：key + 展示名 + 格式化函数 */
import { fmtInt, fmtUSD } from '@/views/earth/formatters';

export const panelRows = [
  { key: 'gdpLatest', label: 'GDP 总量', format: (c) => fmtUSD(c.gdpLatest) },
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
      const pct = ((c.populationLatest / c.population['2005'] - 1) * 100).toFixed(1);
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
