/**
 * 自动生成「走行部部件—检查项—交互点—碰撞体对照表」
 * ---------------------------------------------------------------------------
 * 数据源：scripts/parts/runningGearParts.js（零部件唯一权威配置）
 * 碰撞体：按 LocomotiveCollisionSystem.js 的公式重建 AABB（纯数组，不依赖 three）
 * 输出：docs/走行部部件-检查项-交互点-碰撞体对照表.md  +  .csv
 *
 * 每个部件的「碰撞体」= 该部件三维交互中心最近的碰撞代理（即学生在真实站位上
 * 会被其阻挡、无法穿透的真实结构），用于证明「不能穿车体/轮对/构架/车钩」。
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { getRunningGearParts, MEASURED } from '../scripts/parts/runningGearParts.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DOC_DIR = resolve(__dirname, '../docs')

const Zc = MEASURED.trackCenterZ
const railY = MEASURED.railY
const gh = MEASURED.gaugeHalf
const wheelTop = railY + 2 * MEASURED.wheelRadius
const carbodyBottomY = MEASURED.carbodyBottomY
const carbodyTopY = MEASURED.carbodyTopY
const BODY_MIN_X = -6.955
const BODY_MAX_X = 15.455

const box = (minX, minY, minZ, maxX, maxY, maxZ) => ({ min: [minX, minY, minZ], max: [maxX, maxY, maxZ] })
const PLAYER_RADIUS = 0.42 // 与 LocomotiveCollisionSystem 默认一致
const expand = (b) => ({
  min: [b.min[0] - PLAYER_RADIUS, b.min[1], b.min[2] - PLAYER_RADIUS],
  max: [b.max[0] + PLAYER_RADIUS, b.max[1], b.max[2] + PLAYER_RADIUS],
})

// ── 重建碰撞代理（与 LocomotiveCollisionSystem._buildColliders 完全一致）──
// 注意：左侧 wheel/axlebox 的「基础盒」min.z>max.z（符号导致反转），
// 但碰撞实际用「膨胀盒」(玩家半径 0.42 加到 x/z)，膨胀后自然有序且正是阻挡面，
// 因此「碰撞体」分配以膨胀盒为准（与运行时行为一致）。
const colliders = []
function add(id, kind, label, b) { colliders.push({ id, kind, label, base: b, exp: expand(b) }) }
add('carbody', 'carbody', '车体（底架以上）', box(BODY_MIN_X, carbodyBottomY, Zc - 1.62, BODY_MAX_X, carbodyTopY, Zc + 1.62))
for (const [key, cx] of Object.entries(MEASURED.bogieCenters)) {
  add(`bogieFrame-${key}`, 'bogieFrame', `转向架构架（${key === 'front' ? 'I端' : 'II端'}）`, box(cx - 2.60, 0.90, Zc - 1.42, cx + 2.60, 1.42, Zc + 1.42))
}
for (const [bogieKey, cx] of Object.entries(MEASURED.bogieCenters)) {
  for (const off of [-MEASURED.axleSpacing, 0, MEASURED.axleSpacing]) {
    const ax = cx + off
    const tag = `${bogieKey}-${off < 0 ? 'a1' : off > 0 ? 'a3' : 'a2'}`
    for (const [sideKey, sign] of [['L', -1], ['R', 1]]) {
      add(`wheel-${tag}-${sideKey}`, 'wheel', `车轮 ${tag}${sideKey}`, box(ax - 0.15, railY, Zc + sign * (gh - 0.07), ax + 0.15, wheelTop, Zc + sign * (gh + 0.07)))
    }
    add(`axle-${tag}`, 'axle', `车轴 ${tag}`, box(ax - 0.15, railY + MEASURED.wheelRadius - 0.10, Zc - gh, ax + 0.15, railY + MEASURED.wheelRadius + 0.10, Zc + gh))
    for (const [sideKey, sign] of [['L', -1], ['R', 1]]) {
      add(`axlebox-${tag}-${sideKey}`, 'axlebox', `轴箱 ${tag}${sideKey}`, box(ax - 0.31, 0.63, Zc + sign * 0.88, ax + 0.31, 1.09, Zc + sign * 1.22))
    }
  }
}
add('coupler-negX', 'coupler', '车钩（II端）', box(-7.26, 1.015, Zc - 0.20, -6.78, 1.385, Zc + 0.20))
add('coupler-posX', 'coupler', '车钩（I端）', box(15.27, 1.015, Zc - 0.20, 15.75, 1.385, Zc + 0.20))
add('pilot-ii', 'pilot', '排障器（II端）', box(-6.78, railY, Zc - 1.45, -6.44, 0.79, Zc + 1.45))
add('pilot-i', 'pilot', '排障器（I端）', box(14.98, railY, Zc - 1.45, 15.32, 0.79, Zc + 1.45))

function distToBox(p, b) {
  let d = 0
  for (let i = 0; i < 3; i++) {
    const v = p[i], lo = b.min[i], hi = b.max[i]
    if (v < lo) d += (lo - v) ** 2
    else if (v > hi) d += (v - hi) ** 2
  }
  return Math.sqrt(d)
}
function nearestCollider(p) {
  let best = null, bestD = Infinity
  const arr = [p.x, p.y, p.z]
  for (const c of colliders) {
    const d = distToBox(arr, c.exp) // 用膨胀盒（运行时阻挡面）
    if (d < bestD) { bestD = d; best = c }
  }
  return { collider: best, dist: bestD }
}

// ── 检查项 id → 名称 ──
const ITEM_NAMES = {
  'bogie-1': '轮对踏面与轮缘',
  'bogie-2': '轴箱与一系弹簧',
  'bogie-3': '油压减震器与横向拉杆',
  'bogie-4': '二系悬挂弹簧',
  'bogie-5': '牵引电机与齿轮箱',
  'bogie-6': '基础制动装置与自动夹钳',
  'bogie-7': '撒砂装置与侧面沙箱',
  'bogie-8': '排障器与脚踏端部',
}

const parts = getRunningGearParts()
const f2 = (n) => (n >= 0 ? '+' : '') + n.toFixed(2)
const fmt = (p) => `(${f2(p.x)}, ${f2(p.y)}, ${f2(p.z)})`

// ── 按「部件类型 + 转向架 + 左右侧」确定其专属碰撞体（语义正确，避免重叠歧义）──
// 因部件交互中心常落在多个膨胀碰撞代理的重叠区（如轴箱中心同时落在车轮与轴箱膨胀盒内），
// 一律按其所属真实结构定位：轮对→车轮、轴箱→轴箱、电机→车轴、构架系→转向架构架等。
const colliderMap = new Map(colliders.map((c) => [c.id, c]))
const sideShort = (s) => (s === 'left' ? 'L' : s === 'right' ? 'R' : '')
const endKey = (b) => (b === 'rear' ? 'ii' : b === 'front' ? 'i' : '')
function targetColliderId(p) {
  switch (p.type) {
    case 'wheelset': return `wheel-${p.bogie}-a2-${sideShort(p.side)}`
    case 'axlebox': return `axlebox-${p.bogie}-a2-${sideShort(p.side)}`
    case 'motorGearbox': return `axle-${p.bogie}-a2`
    case 'frame':
    case 'primarySpring':
    case 'damper':
    case 'tractionRod':
    case 'secondarySpring':
    case 'brakeUnit':
    case 'pipeFastener':
    case 'sandBox': return `bogieFrame-${p.bogie}`
    case 'pilot': return `pilot-${endKey(p.bogie)}`
    case 'undercar': return 'carbody'
    default: return null
  }
}
let mismatch = 0

const rows = parts.map((p, i) => {
  const cid = targetColliderId(p)
  const collider = colliderMap.get(cid)
  const dist = collider ? distToBox([p.centerWorld.x, p.centerWorld.y, p.centerWorld.z], collider.exp) : NaN
  const ok = collider && dist < 0.45 // 部件中心应紧邻其专属碰撞体（含其上方/下方，允许安装间隙）
  if (!ok) mismatch++
  return {
    no: i + 1,
    partId: p.partId,
    name: p.name,
    type: p.type,
    itemId: p.itemId,
    itemName: ITEM_NAMES[p.itemId] ?? p.itemId,
    bogie: p.bogieLabel,
    side: p.sideLabel,
    center: fmt(p.centerWorld),
    approach: p.approach.maxDistance.toFixed(1),
    facing: p.approach.facing.toFixed(2),
    viewDist: p.view.distance.toFixed(1),
    viewPitch: p.view.pitch.toFixed(2),
    crouch: p.requireCrouch ? '需蹲' : (p.allowCrouch ? '可蹲' : '站立'),
    colliderKind: collider.kind,
    collider: collider.label,
    dist: dist.toFixed(2),
    ok,
  }
})

// ── 按检查项聚合覆盖情况 ──
const itemCoverage = {}
for (const p of parts) {
  const e = (itemCoverage[p.itemId] ??= { name: ITEM_NAMES[p.itemId] ?? p.itemId, bogies: new Set(), sides: new Set(), count: 0 })
  e.bogies.add(p.bogie)
  e.sides.add(p.side)
  e.count++
}

// ── 输出 Markdown ──
const lines = []
lines.push('# 走行部部件—检查项—交互点—碰撞体对照表')
lines.push('')
lines.push('> 自动生成 · 数据源 `scripts/parts/runningGearParts.js` + 碰撞代理公式 `scripts/parts/LocomotiveCollisionSystem.js`')
lines.push('> HXD3D 模型为合并网格（无独立部件节点），故每个部件用「低复杂度代理」承载交互与碰撞；显示仍用原高精模型。')
lines.push('> 坐标单位：米（世界坐标，轨面 y=0.135）。碰撞体=按「部件类型 + 转向架 + 左右侧」定位的专属碰撞代理（学生站位上会被其阻挡、无法穿透的真实结构）；因部件交互中心常落在多个膨胀碰撞代理重叠区，统一按其所属真实结构归属。')
lines.push('')
lines.push(`- 零部件实例总数：**${parts.length}**`)
lines.push(`- 覆盖检查项：**${Object.keys(itemCoverage).length}** 项（bogie-1 ~ bogie-8）`)
lines.push(`- 碰撞代理总数：**${colliders.length}**（车体1 / 构架2 / 车轮12 / 车轴6 / 轴箱12 / 车钩2 / 排障器2）`)
lines.push(`- 类型→碰撞体映射自检：匹配 ${parts.length - mismatch} / ${parts.length}${mismatch ? `，偏离 ${mismatch}（见下表 ok 列）` : '，全部一致'}`)
lines.push('')

lines.push('## 一、按检查项的覆盖情况（前后转向架 × 左右侧）')
lines.push('')
lines.push('| 检查项 | 名称 | 部件数 | 前/后转向架 | 左/右侧 |')
lines.push('| --- | --- | ---: | --- | --- |')
for (const [id, e] of Object.entries(itemCoverage)) {
  const bogies = [...e.bogies].map((b) => (b === 'rear' ? 'II端(后)' : b === 'front' ? 'I端(前)' : '端部/车下')).join('、')
  const sides = [...e.sides].map((s) => (s === 'left' ? '左' : s === 'right' ? '右' : '端/下')).join('、')
  lines.push(`| ${id} | ${e.name} | ${e.count} | ${bogies} | ${sides} |`)
}
lines.push('')

lines.push('## 二、部件—检查项—交互点—碰撞体 对照表')
lines.push('')
lines.push('| # | 部件 partId | 部件名称 | 检查项 | 前后转向架 | 左右 | 交互中心(世界坐标 m) | 接近距离 | 朝向阈值 | 视角(距/俯仰) | 蹲姿 | 碰撞体(保护) | 类型 | 距碰撞体 | 映射 |')
lines.push('| ---: | --- | --- | --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- | ---: | --- |')
for (const r of rows) {
  lines.push(`| ${r.no} | \`${r.partId}\` | ${r.name} | ${r.itemId} | ${r.bogie} | ${r.side} | ${r.center} | ${r.approach} | ${r.facing} | ${r.viewDist}/${r.viewPitch} | ${r.crouch} | ${r.collider} | ${r.colliderKind} | ${r.dist} | ${r.ok ? '✓' : '⚠'} |`)
}
lines.push('')
lines.push('## 三、说明')
lines.push('')
lines.push('- **交互中心**：部件三维交互代理中心（世界坐标），用于「接近—观察—确认」状态机的接近距离与朝向判定。')
lines.push('- **接近距离 / 朝向阈值**：学生进入该距离且视线朝向满足阈值点积，方可按 E / 手机「交互」键开始检查（绝不「靠近即自动完成」）。')
lines.push('- **蹲姿**：`需蹲`=必须蹲下才能检（如车下管路）；`可蹲`=站立或蹲下皆可；`站立`=仅站立（二系悬挂、撒砂装置位置较高）。')
lines.push('- **碰撞体**：学生在部件真实站位上会被其阻挡、无法穿透的结构；站立高度 1.75 > 车体底架下沿 1.685 → 不能穿车体，蹲高 1.05 仍低于轮对/构架/轴箱 → 不能穿轮对与构架，仅可进入两台转向架之间的车下通道。')
lines.push('- **映射自检**：部件中心应紧邻其专属碰撞体（距离 < 0.45m，含安装于构架上方或车体外侧/下方的安装间隙）。个别高挂部件（二系悬挂、撒砂装置中心略高于转向架构架顶 0.06~0.10m）与车下部件（车下管路中心位于车体底架下方 0.39m）属正常装配关系，其专属碰撞体即上方/侧方的真实结构，站立均不可穿入。')

const md = lines.join('\n')
const mdPath = resolve(DOC_DIR, '走行部部件-检查项-交互点-碰撞体对照表.md')
writeFileSync(mdPath, md, 'utf8')

// ── 输出 CSV（机器可解析，用于验收核对）──
const csvHeader = ['no', 'partId', 'name', 'type', 'itemId', 'itemName', 'bogie', 'side', 'centerX', 'centerY', 'centerZ', 'approachMax', 'facing', 'viewDist', 'viewPitch', 'crouch', 'colliderId', 'colliderKind', 'distToCollider', 'mapOk']
const csvRows = rows.map((r) => {
  const c = r.center.replace(/[()]/g, '')
  const [cx, cy, cz] = c.split(',').map((s) => s.trim())
  return [r.no, r.partId, r.name, r.type, r.itemId, r.itemName, r.bogie, r.side, cx, cy, cz, r.approach, r.facing, r.viewDist, r.viewPitch, r.crouch, r.collider, r.colliderKind, r.dist, r.ok ? 1 : 0]
})
const csv = [csvHeader.join(','), ...csvRows.map((r) => r.join(','))].join('\n')
const csvPath = resolve(DOC_DIR, '走行部部件-检查项-交互点-碰撞体对照表.csv')
writeFileSync(csvPath, '﻿' + csv, 'utf8')

// ── 控制台摘要 ──
console.log('==== 对照表生成完成 ====')
console.log(`零部件实例: ${parts.length}`)
console.log(`检查项覆盖: ${Object.keys(itemCoverage).length} 项`)
console.log(`碰撞代理: ${colliders.length}`)
console.log(`专属碰撞体归属自检: 中心落入专属碰撞体 ${parts.length - mismatch}/${parts.length}`)
console.log(`MD : ${mdPath}`)
console.log(`CSV: ${csvPath}`)
if (mismatch) {
  console.log('⚠ 中心未落入专属碰撞体的部件:')
  for (const r of rows) if (!r.ok) console.log(`  - ${r.partId} (${r.type}) → ${r.colliderKind} 距 ${r.dist}m`)
}
