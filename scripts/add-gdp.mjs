// 一次性脚本：从 World Bank API 抓取 2023 年 GDP 总量（NY.GDP.MKTP.CD，现价美元）
// 映射到 country-info.json，写入 gdpLatest 字段（人均由前端用 gdpLatest/populationLatest 现算）。
// 复用 add-population.mjs 的别名表 —— 两个脚本的国名映射必须保持一致。
// 运行：node scripts/add-gdp.mjs
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'src/assets/world-data/country-info.json'
const data = JSON.parse(readFileSync(FILE, 'utf8'))

// 本地 name → World Bank 国家名 的别名表（与 add-population.mjs 保持同步）
const ALIAS = {
  Bahamas: 'Bahamas, The',
  Burma: 'Myanmar',
  Congo: 'Congo, Rep.',
  'Democratic Republic of the Congo': 'Congo, Dem. Rep.',
  'Cape Verde': 'Cabo Verde',
  'Cook Islands': null,
  Egypt: 'Egypt, Arab Rep.',
  'Czech Republic': 'Czechia',
  'French Guiana': null,
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
  'Netherlands Antilles': null,
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
  Taiwan: null,
}

async function main() {
  // GDP 常有国家缺 2023 值（年报滞后），取 date=2022:2024 从新到旧兜底
  const res = await fetch(
    'https://api.worldbank.org/v2/en/country/all/indicator/NY.GDP.MKTP.CD?format=json&per_page=1200&date=2022:2024',
  )
  const [, rows] = await res.json()
  if (!rows) {
    console.error('WB API 返回空')
    process.exit(1)
  }
  // 每个国家保留最新年份的值（WB 返回按国家分组、年份降序）
  const wb = new Map()
  for (const r of rows) {
    if (r.value == null) continue
    if (!wb.has(r.country.value)) wb.set(r.country.value, { value: r.value, date: r.date })
  }

  let hit = 0
  const missing = []
  for (const c of data) {
    const wbName = Object.prototype.hasOwnProperty.call(ALIAS, c.name) ? ALIAS[c.name] : c.name
    const row = wbName ? wb.get(wbName) : undefined
    if (row) {
      c.gdpLatest = Math.round(row.value)
      c.gdpYear = row.date
      hit++
    } else {
      missing.push(c.name)
    }
  }

  // 字段顺序：gdpLatest/gdpYear 插在 populationLatest 之前
  const ordered = data.map((c) => {
    const { name, nameZH, min, max, area, lat, lon, gdpLatest, gdpYear, populationLatest, population } = c
    return { name, nameZH, min, max, area, lat, lon, gdpLatest, gdpYear, populationLatest, population }
  })

  writeFileSync(FILE, JSON.stringify(ordered, null, 2) + '\n')
  console.log(`命中 ${hit}/${data.length}`)
  if (missing.length) console.log('无 GDP 数据:', missing.join(' | '))
}

main()
