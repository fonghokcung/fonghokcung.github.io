// 一次性脚本：从 World Bank API 抓取 2023 年各国总人口（SP.POP.TOTL），
// 映射到 country-info.json 的每个国家，写入 populationLatest 字段。
// 运行：node scripts/add-population.mjs
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'src/assets/world-data/country-info.json'
const data = JSON.parse(readFileSync(FILE, 'utf8'))

// 本地 name → World Bank 国家名 的别名表（两者数据源命名规范不同）
const ALIAS = {
  Bahamas: 'Bahamas, The',
  Burma: 'Myanmar',
  Congo: 'Congo, Rep.',
  'Democratic Republic of the Congo': 'Congo, Dem. Rep.',
  'Cape Verde': 'Cabo Verde',
  'Cook Islands': null, // WB 无
  Egypt: 'Egypt, Arab Rep.',
  'Czech Republic': 'Czechia',
  'French Guiana': null, // WB 归入 France
  'Falkland Islands (Malvinas)': null,
  'Micronesia, Federated States of': 'Micronesia, Fed. Sts.',
  Gambia: 'Gambia, The',
  'Iran (Islamic Republic of)': 'Iran, Islamic Rep.',
  Kyrgyzstan: 'Kyrgyz Republic',
  "Korea, Democratic People's Republic of": 'Korea, Dem. People’s Rep.',
  'Korea, Republic of': 'Korea, Rep.',
  "Lao People's Democratic Republic": 'Lao PDR',
  Slovakia: 'Slovak Republic',
  'Libyan Arab Jamahiriya': 'Libya',
  Martinique: null,
  Montserrat: null,
  'The former Yugoslav Republic of Macedonia': 'North Macedonia',
  Niue: null,
  Anguilla: null,
 'Hong Kong': 'Hong Kong SAR, China',
  Macau: 'Macao SAR, China',
  Palestine: 'West Bank and Gaza',
  Mayotte: null,
  'Åland Islands': null,
  'Norfolk Island': null,
  'Cocos (Keeling) Islands': null,
  Antarctica: null,
  'Bouvet Island': null,
  'French Southern and Antarctic Lands': null,
  'Heard Island and McDonald Islands': null,
  'British Indian Ocean Territory': null,
  'Christmas Island': null,
  'United States Minor Outlying Islands': null,
  Nauru: null,
  Reunion: null,
  'Republic of Moldova': 'Moldova',
  'Puerto Rico': 'Puerto Rico',
  Russia: 'Russian Federation',
  'Saint Kitts and Nevis': 'St. Kitts and Nevis',
  'Saint Lucia': 'St. Lucia',
  Tokelau: null,
  Turkey: 'Turkiye',
  'United Republic of Tanzania': 'Tanzania',
  'Saint Vincent and the Grenadines': 'St. Vincent and the Grenadines',
  Venezuela: 'Venezuela, RB',
  'United States Virgin Islands': 'Virgin Islands (U.S.)',
  'Wallis and Futuna Islands': null,
  Swaziland: 'Eswatini',
  Yemen: 'Yemen, Rep.',
  Guadeloupe: null,
  'Netherlands Antilles': null, // 2010 年已解体，WB 无
  'Pitcairn Islands': null,
  'Saint Pierre and Miquelon': null,
  'Saint Helena': 'St. Helena',
  'Western Sahara': null,
  'Holy See (Vatican City)': null,
  Svalbard: null,
  'Saint Martin': null,
  'Saint Barthelemy': null,
  Guernsey: null,
  Jersey: null,
  'South Georgia South Sandwich Islands': null,
  Taiwan: null, // WB 无台湾条目
}

// 2005 数据源里"疑似 WB 有"但其实要按别名或原样再核对的，直接原样查询兜底
async function main() {
  const res = await fetch(
    'https://api.worldbank.org/v2/en/country/all/indicator/SP.POP.TOTL?format=json&per_page=400&date=2023',
  )
  const [, rows] = await res.json()
  if (!rows) {
    console.error('WB API 返回空')
    process.exit(1)
  }
  // WB 返回所有经济体 + 聚合地区；只留有数值的行
  const wb = new Map()
  for (const r of rows) {
    if (r.value != null) wb.set(r.country.value, r.value)
  }

  let hit = 0
  const missing = []
  for (const c of data) {
    const wbName = Object.prototype.hasOwnProperty.call(ALIAS, c.name) ? ALIAS[c.name] : c.name
    const pop = wbName ? wb.get(wbName) : undefined
    if (pop != null) {
      c.populationLatest = Math.round(pop)
      hit++
    } else {
      missing.push(c.name)
    }
  }

  // 字段顺序：name, nameZH, ..., population 前插 populationLatest
  const ordered = data.map((c) => {
    const { name, nameZH, min, max, area, lat, lon, population, populationLatest } = c
    return { name, nameZH, min, max, area, lat, lon, populationLatest, population }
  })

  writeFileSync(FILE, JSON.stringify(ordered, null, 2) + '\n')
  console.log(`命中 ${hit}/${data.length}`)
  if (missing.length) console.log('无 2023 数据（保留仅 2005）:', missing.join(' | '))
}

main()
