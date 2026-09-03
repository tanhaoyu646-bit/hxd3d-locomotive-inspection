/**
 * 走行部检查 · 自动化验收脚本
 * ---------------------------------------------------------------------------
 * 用断言验证教学硬约束，避免靠肉眼在浏览器里试：
 *   1. 站立不能穿入车体
 *   2. 蹲下可进入车下检查通道（且站立时同一位置被挡）
 *   3. 不能穿过轮对 / 转向架构架 / 车钩
 *   4. 空间分区识别正确（cab / running-gear / body-side / coupler / outside）
 *   5. 可沿碰撞边缘滑动，不卡死
 *   6. 零部件配置与检查项对应完整、前后转向架左右侧均可检
 *
 * 用法：node tools/verify-running-gear.mjs
 * 退出码：0 全部通过；1 存在失败项
 */
import * as THREE from 'three'
import { createLocomotiveCollisionSystem } from '../scripts/parts/LocomotiveCollisionSystem.js'
import {
  getRunningGearParts,
  getPartsByItem,
  getRunningGearItemIds,
  MEASURED,
} from '../scripts/parts/runningGearParts.js'

const Zc = MEASURED.trackCenterZ
const STAND = 1.75
const CROUCH = 1.05

let pass = 0
let fail = 0
const failures = []

function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`) }
  else { fail += 1; failures.push(name); console.log(`  ✗ ${name}  ${detail}`) }
}
function section(t) { console.log(`\n${t}`) }

const sys = createLocomotiveCollisionSystem({ modelBounds: null })
sys.registerInteractionProxies(getRunningGearParts())

const at = (x, z, y = 0) => new THREE.Vector3(x, y, z)

// ───────────────────────── 1. 车体不可穿越 ─────────────────────────
section('1. 站立不能穿入车体')
{
  // 车体中部，从左侧站位（Δz=-2.5）走向车体内部（Δz=0）
  const from = at(4.25, Zc - 2.5)
  const into = at(4.25, Zc)
  check('站立走向车体中心被挡',
    sys.isBlocked(into, STAND) === true,
    `车体底架下沿 ${MEASURED.carbodyBottomY}m < 站立高 ${STAND}m`)

  const res = sys.resolve(from, into.clone(), { eyeHeight: STAND })
  check('站立无法移动进入车体（解算后被拦在车外）',
    Math.abs(res.z - Zc) > 1.0,
    `解算后 z=${res.z.toFixed(2)}（车体中线 z=${Zc}）`)
}

// ───────────────────────── 2. 蹲下可进车下通道 ─────────────────────────
section('2. 蹲下可进入车下检查通道')
{
  const under = at(4.25, Zc) // 两转向架之间、车体正下方
  check('蹲下时车下通道可通行',
    sys.isBlocked(under, CROUCH) === false,
    `蹲高 ${CROUCH}m < 底架下沿 ${MEASURED.carbodyBottomY}m`)
  check('站立时同一位置被车体挡住',
    sys.isBlocked(under, STAND) === true)

  // 车下通道内可横向移动（左右走动检查底架）
  const a = at(4.25, Zc - 1.0)
  const b = at(4.25, Zc + 1.0)
  check('蹲下可在车下通道内横向通行',
    !sys.isBlocked(a, CROUCH) && !sys.isBlocked(b, CROUCH))
  const moved = sys.resolve(a, b.clone(), { eyeHeight: CROUCH })
  check('蹲下横向移动未被拦截',
    Math.abs(moved.z - b.z) < 0.01, `解算后 z=${moved.z.toFixed(2)}`)

  check('车下通道分区识别为 running-gear',
    sys.getZone(under) === 'running-gear', `实际=${sys.getZone(under)}`)
}

// ───────────────────────── 3. 轮对/构架/车钩不可穿越 ─────────────────────────
section('3. 不能穿过轮对、转向架构架、车钩')
{
  const gh = MEASURED.gaugeHalf
  for (const [bogieKey, cx] of Object.entries(MEASURED.bogieCenters)) {
    for (const off of [-MEASURED.axleSpacing, 0, MEASURED.axleSpacing]) {
      const ax = cx + off
      for (const sign of [-1, 1]) {
        const p = at(ax, Zc + sign * gh)
        check(`轮对 ${bogieKey} 轴${off === 0 ? 2 : off < 0 ? 1 : 3} ${sign < 0 ? '左' : '右'} · 站立不可穿`,
          sys.isBlocked(p, STAND) === true)
        check(`轮对 ${bogieKey} 轴${off === 0 ? 2 : off < 0 ? 1 : 3} ${sign < 0 ? '左' : '右'} · 蹲下不可穿`,
          sys.isBlocked(p, CROUCH) === true)
      }
    }
  }
  for (const [bogieKey, cx] of Object.entries(MEASURED.bogieCenters)) {
    const p = at(cx, Zc)
    check(`转向架构架 ${bogieKey} · 蹲下不可穿`,
      sys.isBlocked(p, CROUCH) === true)
  }
  for (const [label, cx] of [['II端', -7.02], ['I端', 15.51]]) {
    const p = at(cx, Zc)
    check(`车钩 ${label} · 蹲下不可穿`, sys.isBlocked(p, CROUCH) === true)
  }
}

// ───────────────────────── 4. 空间分区 ─────────────────────────
section('4. 空间分区识别')
{
  const cases = [
    ['车钩区（II端）', at(-7.0, Zc), 'coupler'],
    ['车钩区（I端）', at(15.5, Zc), 'coupler'],
    ['司机室入口（I端）', at(14.0, Zc + 0.3), 'cab'],
    ['司机室入口（II端）', at(-5.5, Zc - 0.3), 'cab'],
    ['走行部（II端转向架）', at(-1.78, Zc - 2.5), 'running-gear'],
    ['走行部（I端转向架）', at(10.35, Zc + 2.5), 'running-gear'],
    ['车体侧（左侧中部）', at(4.25, Zc - 2.5), 'body-side'],
    ['车体侧（右侧中部）', at(4.25, Zc + 2.5), 'body-side'],
    ['机车外', at(20, Zc + 6), 'outside'],
  ]
  for (const [label, p, expected] of cases) {
    const got = sys.getZone(p)
    check(`${label} → ${expected}`, got === expected, got === expected ? '' : `实际=${got}`)
  }
}

// ───────────────────────── 5. 贴边滑动不卡死 ─────────────────────────
section('5. 沿碰撞边缘滑动')
{
  // 沿车体左侧外墙向车头方向走：纵向应可自由推进（横向被挡）
  const start = at(-1.0, Zc - 2.2)
  let pos = start.clone()
  let stuck = 0
  for (let i = 0; i < 60; i += 1) {
    const desired = new THREE.Vector3(pos.x + 0.2, 0, pos.z - 0.05) // 前推 + 轻微贴向车体
    const next = sys.resolve(pos.clone(), desired, { eyeHeight: STAND })
    if (Math.abs(next.x - pos.x) < 1e-6) stuck += 1
    pos = next.clone()
  }
  check('沿车体纵向可持续推进（不卡死）',
    stuck === 0 && pos.x > start.x + 9,
    `推进 ${(pos.x - start.x).toFixed(2)}m，停滞 ${stuck} 帧`)

  // 陷入几何体时可被推出（典型场景：车下蹲行途中松开蹲键站起来）
  const inside = at(4.25, Zc)
  check('站立时该位置确实陷入车体', sys.isBlocked(inside, STAND) === true)
  const pushed = sys.depenetrate(inside, STAND) // 原地修改
  check('站立陷入车体时可被推出', pushed === true)
  check('推出后不再与车体冲突',
    sys.isBlocked(inside, STAND) === false,
    `推出后 z=${inside.z.toFixed(2)}（车体中线 z=${Zc.toFixed(2)}）`)
}

// ───────────────────────── 6. 零部件配置完整性 ─────────────────────────
section('6. 零部件配置与检查项对应')
{
  const parts = getRunningGearParts()
  check('零部件实例已生成', parts.length > 0, `共 ${parts.length} 个`)

  const itemIds = getRunningGearItemIds()
  check('覆盖走行部全部 8 个检查项', itemIds.length === 8, `实际 ${itemIds.length}: ${itemIds.join(', ')}`)

  /** 部件是否在指定侧具备可到达的检查站位 */
  const hasZoneOnSide = (part, which) => part.zones.some((zo) => {
    const [w0, w1] = zo.region.w
    const mid = (w0 + w1) / 2
    // 车体外侧：左侧 w<0.5 且明显偏外；右侧 w>0.5 且明显偏外
    return which === 'left' ? mid < 0.35 : mid > 0.65
  })

  for (const id of itemIds) {
    const ps = getPartsByItem(id)
    const bogies = new Set(ps.map((p) => p.bogie))
    const hasBothBogies = bogies.has('front') && bogies.has('rear')
    check(`${id} · 前后转向架均可检`, hasBothBogies, `转向架=${[...bogies].join('/')}`)

    // 左右侧判定分两层：
    //   ① 每个部件实例必须在它自己所属的侧别上有可到达的站位
    //      （左侧件只需左站位，右侧件只需右站位；横跨车宽的整体件两侧都要有）
    //   ② 该检查项整体必须左右两侧都覆盖到
    const CENTER_ONLY = new Set(['undercar']) // 车下通道居中进入，不分左右
    const sideFail = ps.filter((p) => {
      if (CENTER_ONLY.has(p.type)) return false
      if (p.side === 'left') return !hasZoneOnSide(p, 'left')
      if (p.side === 'right') return !hasZoneOnSide(p, 'right')
      return !(hasZoneOnSide(p, 'left') && hasZoneOnSide(p, 'right'))
    })
    check(`${id} · 每个部件在所属侧别有站位`, sideFail.length === 0,
      sideFail.length ? `缺少站位: ${sideFail.map((p) => p.partId).join(', ')}` : '')

    const covers = (which) => ps.some((p) => {
      if (CENTER_ONLY.has(p.type)) return false
      if (p.side === which) return hasZoneOnSide(p, which)
      return p.side === 'both' && hasZoneOnSide(p, which)
    })
    check(`${id} · 左右侧均可检`, covers('left') && covers('right'),
      `左=${covers('left')} 右=${covers('right')}`)
  }

  // 每个部件都必须齐备交互所需字段
  const required = ['partId', 'name', 'itemId', 'side', 'bogie', 'center', 'zones', 'view', 'approach', 'proxySize', 'occluders', 'judge']
  const missing = parts.filter((p) => required.some((k) => p[k] == null))
  check('每个部件字段齐备', missing.length === 0,
    missing.length ? `缺失: ${missing.slice(0, 3).map((p) => p.partId).join(', ')}` : '')

  const noJudge = parts.filter((p) => !p.judge?.pass || !p.judge?.faults?.length)
  check('每个部件都有合格/异常判定内容', noJudge.length === 0,
    noJudge.length ? `缺失: ${noJudge.map((p) => p.partId).join(', ')}` : '')

  const noZone = parts.filter((p) => !p.zones?.length)
  check('每个部件都有允许的检查区域', noZone.length === 0)

  const perAxleTypes = ['wheelset', 'axlebox', 'primarySpring', 'brakeUnit']
  for (const type of perAxleTypes) {
    const typed = parts.filter((p) => p.type === type)
    const axles = new Set(typed.map((p) => p.axleNo))
    check(`${type} · 六根轴均有独立交互锚点`,
      typed.length === 12 && [1, 2, 3, 4, 5, 6].every((n) => axles.has(n)),
      `实例=${typed.length} 轴号=${[...axles].join('/')}`)
  }

  const allowedFaultTypes = new Set(['crack', 'tread-scratch', 'tread-peel', 'burn', 'loose-bolt', 'leak'])
  const oldFaultSpecs = parts.flatMap((p) => p.judge?.faults ?? [])
    .filter((fault) => !allowedFaultTypes.has(fault.faultType))
  check('走行部故障全部按六类符号语义配置', oldFaultSpecs.length === 0,
    oldFaultSpecs.length ? `仍有 ${oldFaultSpecs.length} 项旧配置` : '')
}

// ───────────────────────── 汇总 ─────────────────────────
console.log(`\n${'='.repeat(64)}`)
console.log(`断言通过 ${pass} · 失败 ${fail}`)
if (fail) {
  console.log('\n失败项:')
  failures.forEach((f) => console.log(`  - ${f}`))
}
console.log('='.repeat(64))
process.exit(fail ? 1 : 0)
