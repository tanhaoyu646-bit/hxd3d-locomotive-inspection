/**
 * 机车碰撞与空间分区系统 V2
 * ---------------------------------------------------------------------------
 * 替代旧的 SegmentedCollisionResolver（只按整车包围盒比例切 4 段，
 * 既不能代表轮对/轴箱/制动装置，getZone() 也没实现）。
 *
 * 本系统按实测几何建立**独立碰撞代理**，原高精模型不参与碰撞运算，
 * 只用于显示（43.9 万三角形直接做碰撞既慢又不可用）。
 *
 * 碰撞代理清单
 *   carbody      车体（底架以上实心）
 *   bogieFrame   转向架构架 ×2
 *   wheel        车轮 ×12（6 轮对 × 左右）
 *   axle         车轴 ×6
 *   axlebox      轴箱 ×12
 *   coupler      车钩 ×2
 *   pilot        排障器 ×2
 *
 * 高度分层行为（关键教学约束）
 *   站立（眼高 1.75m，头顶 1.75m）> 车体底架下沿 1.685m
 *     → 站立无法进入车下，也不能穿入车体        ✓ 不能穿车体
 *   蹲下（眼高 1.05m）
 *     → 可进入两台转向架之间的车下检查通道      ✓ 可下蹲检车下
 *     → 但轮对(0.135~1.385)、构架(0.90~1.42)、轴箱(0.63~1.09) 仍高于蹲高
 *       → 不能穿过轮对、转向架构架、车钩        ✓ 不能穿轮对
 *
 * 解算：分轴解算 + 最小穿透推出，保证贴边滑动且不会卡死。
 * 调试：setDebug(true) 显示碰撞代理（红）/ 交互代理（青）/ 分区（黄），
 *       默认关闭，关闭后不参与渲染，不影响教学画面。
 * ---------------------------------------------------------------------------
 */
import * as THREE from 'three'
import { MEASURED, UNDERCAR_ZONE, toWorld } from './runningGearParts.js'

const EPSILON = 1e-4
const DEFAULT_PLAYER_RADIUS = 0.42

/** 车体本体纵向范围（实测 Static_Main_Body 的 X 向包围） */
const BODY_MIN_X = -6.955
const BODY_MAX_X = 15.455

function box(minX, minY, minZ, maxX, maxY, maxZ) {
  return new THREE.Box3(
    new THREE.Vector3(minX, minY, minZ),
    new THREE.Vector3(maxX, maxY, maxZ),
  )
}

export class LocomotiveCollisionSystem {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.playerRadius]
   * @param {number} [opts.standingHeight]  站立时玩家碰撞体高度（= 眼高）
   * @param {number} [opts.crouchHeight]    蹲下时玩家碰撞体高度
   * @param {THREE.Box3} [opts.modelBounds] 运行时实测包围盒，用于校验几何假设
   */
  constructor(opts = {}) {
    this.playerRadius = opts.playerRadius ?? DEFAULT_PLAYER_RADIUS
    this.standingHeight = opts.standingHeight ?? 1.75
    this.crouchHeight = opts.crouchHeight ?? 1.05

    this.colliders = []
    this.zones = []
    this.interactionProxies = []

    this._tmp = new THREE.Vector3()
    this._candidate = new THREE.Vector3()
    this._resolved = new THREE.Vector3()

    this._buildColliders()
    this._buildZones()

    if (opts.modelBounds) this._verifyAgainstModel(opts.modelBounds)

    // 调试可视化
    this.debugGroup = new THREE.Group()
    this.debugGroup.name = 'CollisionDebug'
    this.debugGroup.visible = false
    this._debugBuilt = false
  }

  // ───────────────────────── 碰撞代理构建 ─────────────────────────
  _addCollider({ id, kind, label, box, note }) {
    const r = this.playerRadius
    // 水平方向按玩家半径膨胀（玩家是圆柱，用 AABB 近似）
    const expanded = new THREE.Box3(
      new THREE.Vector3(box.min.x - r, box.min.y, box.min.z - r),
      new THREE.Vector3(box.max.x + r, box.max.y, box.max.z + r),
    )
    const worldCenter = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    this.colliders.push({ id, kind, label, box, expanded, note, worldCenter, size })
  }

  _buildColliders() {
    const Zc = MEASURED.trackCenterZ
    const { railY, carbodyBottomY, carbodyTopY } = MEASURED
    const wheelTop = railY + 2 * MEASURED.wheelRadius
    const gh = MEASURED.gaugeHalf

    // 1) 车体：底架下沿到车顶，实心
    this._addCollider({
      id: 'carbody',
      kind: 'carbody',
      label: '车体（底架以上）',
      note: '站立高度 1.75 > 底架下沿 1.685 → 站立无法进入车下',
      box: box(BODY_MIN_X, carbodyBottomY, Zc - 1.62, BODY_MAX_X, carbodyTopY, Zc + 1.62),
    })

    // 2) 转向架构架 ×2（侧梁 + 横梁，轴距 2×2.15 ⇒ 纵向半长 2.6）
    for (const [key, cx] of Object.entries(MEASURED.bogieCenters)) {
      this._addCollider({
        id: `bogieFrame-${key}`,
        kind: 'bogieFrame',
        label: `转向架构架（${key === 'front' ? 'I端' : 'II端'}）`,
        note: '构架高于蹲高 1.05 → 蹲下也不可穿过',
        box: box(cx - 2.60, 0.90, Zc - 1.42, cx + 2.60, 1.42, Zc + 1.42),
      })
    }

    // 3) 轮对 ×6（每台转向架 3 轴，轴距 2.15），左右各一车轮
    for (const [bogieKey, cx] of Object.entries(MEASURED.bogieCenters)) {
      for (const off of [-MEASURED.axleSpacing, 0, MEASURED.axleSpacing]) {
        const ax = cx + off
        const tag = `${bogieKey}-${off < 0 ? 'a1' : off > 0 ? 'a3' : 'a2'}`
        for (const [sideKey, sign] of [['L', -1], ['R', 1]]) {
          this._addCollider({
            id: `wheel-${tag}-${sideKey}`,
            kind: 'wheel',
            label: `车轮 ${tag}${sideKey}`,
            note: '轮径 1250mm，占据 0.135~1.385 → 站立与蹲下均不可穿过',
            box: box(ax - 0.15, railY, Zc + sign * (gh - 0.07), ax + 0.15, wheelTop, Zc + sign * (gh + 0.07)),
          })
        }
        // 车轴：横跨轨距，防止从两轮之间钻过
        this._addCollider({
          id: `axle-${tag}`,
          kind: 'axle',
          label: `车轴 ${tag}`,
          note: '防止从同一轮对两轮之间穿过',
          box: box(ax - 0.15, railY + MEASURED.wheelRadius - 0.10, Zc - gh, ax + 0.15, railY + MEASURED.wheelRadius + 0.10, Zc + gh),
        })
        // 4) 轴箱 ×12
        for (const [sideKey, sign] of [['L', -1], ['R', 1]]) {
          this._addCollider({
            id: `axlebox-${tag}-${sideKey}`,
            kind: 'axlebox',
            label: `轴箱 ${tag}${sideKey}`,
            box: box(ax - 0.31, 0.63, Zc + sign * 0.88, ax + 0.31, 1.09, Zc + sign * 1.22),
          })
        }
      }
    }

    // 5) 车钩 ×2（实测 Coupler_NegativeX / Coupler_PositiveX 包围盒）
    this._addCollider({
      id: 'coupler-negX',
      kind: 'coupler',
      label: '车钩（II端）',
      box: box(-7.26, 1.015, Zc - 0.20, -6.78, 1.385, Zc + 0.20),
    })
    this._addCollider({
      id: 'coupler-posX',
      kind: 'coupler',
      label: '车钩（I端）',
      box: box(15.27, 1.015, Zc - 0.20, 15.75, 1.385, Zc + 0.20),
    })

    // 6) 排障器 ×2
    this._addCollider({
      id: 'pilot-ii',
      kind: 'pilot',
      label: '排障器（II端）',
      box: box(-6.78, railY, Zc - 1.45, -6.44, 0.79, Zc + 1.45),
    })
    this._addCollider({
      id: 'pilot-i',
      kind: 'pilot',
      label: '排障器（I端）',
      box: box(14.98, railY, Zc - 1.45, 15.32, 0.79, Zc + 1.45),
    })
  }

  // ───────────────────────── 空间分区 ─────────────────────────
  /**
   * 分区按优先级判定：coupler > cab > running-gear > body-side > outside
   * 区域可越界（车体外侧的站位带同样属于对应分区）
   */
  _buildZones() {
    const Zc = MEASURED.trackCenterZ
    const half = (v) => v
    // coupler：车钩正前方 1.6m 内、横向 ±1.4m
    this.zones.push({
      id: 'coupler', kind: 'zone', label: '车钩区',
      box: box(MEASURED.boundsMin[0] - 0.2, 0, Zc - 1.4, -5.9, 3.0, Zc + 1.4),
    })
    this.zones.push({
      id: 'coupler', kind: 'zone', label: '车钩区',
      box: box(15.2, 0, Zc - 1.4, MEASURED.boundsMax[0] + 0.2, 3.0, Zc + 1.4),
    })
    // cab：司机室入口 —— 车体端部 3.2m 范围内、车体两侧站位带（含门区）
    this.zones.push({
      id: 'cab', kind: 'zone', label: '司机室入口（II端）',
      box: box(BODY_MIN_X - 0.4, 0, Zc - 2.9, BODY_MIN_X + 3.2, 3.0, Zc + 2.9),
    })
    this.zones.push({
      id: 'cab', kind: 'zone', label: '司机室入口（I端）',
      box: box(BODY_MAX_X - 3.2, 0, Zc - 2.9, BODY_MAX_X + 0.4, 3.0, Zc + 2.9),
    })
    // running-gear：两台转向架纵向 ±3.4m 范围 + 车下通道
    for (const [key, cx] of Object.entries(MEASURED.bogieCenters)) {
      this.zones.push({
        id: 'running-gear', kind: 'zone', label: `走行部（${key === 'front' ? 'I端' : 'II端'}转向架）`,
        box: box(cx - 3.4, 0, Zc - 3.0, cx + 3.4, 3.0, Zc + 3.0),
      })
    }
    const uc = toWorld({ u: UNDERCAR_ZONE.u[0], v: 0, w: UNDERCAR_ZONE.w[0] })
    const uc2 = toWorld({ u: UNDERCAR_ZONE.u[1], v: 0, w: UNDERCAR_ZONE.w[1] })
    this.zones.push({
      id: 'running-gear', kind: 'zone', label: '走行部（车下通道）',
      box: box(uc.x, 0, uc.z, uc2.x, 2.2, uc2.z),
    })
    // body-side：车体两侧站位带（除去上述区域后命中即车体侧）
    this.zones.push({
      id: 'body-side', kind: 'zone', label: '车体侧（左侧）',
      box: box(BODY_MIN_X, 0, Zc - 3.2, BODY_MAX_X, 3.2, Zc - 1.6),
    })
    this.zones.push({
      id: 'body-side', kind: 'zone', label: '车体侧（右侧）',
      box: box(BODY_MIN_X, 0, Zc + 1.6, BODY_MAX_X, 3.2, Zc + 3.2),
    })
    void half
  }

  _verifyAgainstModel(modelBounds) {
    const mn = modelBounds.min
    const mx = modelBounds.max
    const d = (a, b) => Math.abs(a - b)
    const drift = Math.max(
      d(mn.x, MEASURED.boundsMin[0]), d(mn.y, MEASURED.boundsMin[1]), d(mn.z, MEASURED.boundsMin[2]),
      d(mx.x, MEASURED.boundsMax[0]), d(mx.y, MEASURED.boundsMax[1]), d(mx.z, MEASURED.boundsMax[2]),
    )
    if (drift > 0.05) {
      console.warn(
        `[CollisionSystem] 实测几何与运行时模型包围盒偏差 ${drift.toFixed(3)}m，` +
        '碰撞代理位置可能失准，请重新运行 tools/inspect-glb.mjs 校对 MEASURED 常量。',
      )
    }
    return drift
  }

  // ───────────────────────── 碰撞查询 ─────────────────────────
  /**
   * 玩家竖直区间 [y, y+height] 与碰撞代理竖直区间是否重叠
   * 水平用膨胀后的盒子（玩家半径），竖直用原始盒子
   */
  _overlaps(collider, x, y, z, height) {
    const b = collider.box
    const eb = collider.expanded
    if (y + height <= b.min.y + EPSILON) return false
    if (y >= b.max.y - EPSILON) return false
    if (x <= eb.min.x + EPSILON || x >= eb.max.x - EPSILON) return false
    if (z <= eb.min.z + EPSILON || z >= eb.max.z - EPSILON) return false
    return true
  }

  _hitAny(x, y, z, height) {
    for (const c of this.colliders) {
      if (this._overlaps(c, x, y, z, height)) return c
    }
    return null
  }

  /** 该高度是否与任一碰撞代理冲突 */
  isBlocked(position, height) {
    return this._hitAny(position.x, position.y, position.z, height) !== null
  }

  /**
   * 最小穿透推出：玩家已陷入碰撞体时（例如车下蹲行中站起），
   * 沿穿透最浅的水平轴推出，避免卡死在几何内部
   */
  depenetrate(position, height) {
    let guard = 0
    while (guard < 4) {
      const hit = this._hitAny(position.x, position.y, position.z, height)
      if (!hit) break
      guard += 1
      const eb = hit.expanded
      const dxMin = position.x - eb.min.x      // 向 -X 推出的距离
      const dxMax = eb.max.x - position.x      // 向 +X 推出
      const dzMin = position.z - eb.min.z
      const dzMax = eb.max.z - position.z
      const minDX = Math.min(dxMin, dxMax)
      const minDZ = Math.min(dzMin, dzMax)
      if (minDX <= minDZ) position.x += dxMin < dxMax ? -dxMin - EPSILON : dxMax + EPSILON
      else position.z += dzMin < dzMax ? -dzMin - EPSILON : dzMax + EPSILON
    }
    return guard > 0
  }

  /**
   * 分轴解算：先整体，再单轴，保证沿车体滑动；
   * 若仍被阻挡（角点），保持原位并做一次推出，避免卡死
   * @param {THREE.Vector3} current
   * @param {THREE.Vector3} desired
   * @param {Object} ctx { eyeHeight, crouching, deltaTime }
   * @returns {THREE.Vector3}
   */
  resolve(current, desired, ctx = {}) {
    const height = ctx.eyeHeight ?? this.standingHeight
    this._resolved.copy(current)
    this._resolved.y = desired.y
    // 旧存档、帧间状态或蹲起切换可能让玩家起点落入代理内部；先推出再继续解算，
    // 否则两轴同时被判定阻挡时会表现为完全卡死。
    this.depenetrate(this._resolved, height)
    const baseX = this._resolved.x
    const baseZ = this._resolved.z

    // 目标点无碰撞 → 直接通过（最常见路径，快速返回）
    if (!this._hitAny(desired.x, this._resolved.y, desired.z, height)) {
      this._resolved.x = desired.x
      this._resolved.z = desired.z
      return this._resolved
    }

    // 试 X 轴单独移动（沿 Z 墙滑动）
    if (!this._hitAny(desired.x, this._resolved.y, baseZ, height)) {
      this._resolved.x = desired.x
    }
    // 试 Z 轴单独移动（在已确定的 X 基础上）
    this._candidate.set(this._resolved.x, this._resolved.y, desired.z)
    if (!this._hitAny(this._candidate.x, this._candidate.y, this._candidate.z, height)) {
      this._resolved.z = desired.z
    }

    // 角点仍被阻挡：原地不动，并推出已穿透的部分
    if (this._hitAny(this._resolved.x, this._resolved.y, this._resolved.z, height)) {
      this._resolved.x = baseX
      this._resolved.z = baseZ
    }
    return this._resolved
  }

  /**
   * 空间分区识别
   * @returns {'cab'|'running-gear'|'body-side'|'coupler'|'outside'}
   */
  getZone(position) {
    const p = this._tmp.set(position.x, position.y, position.z)
    // 车下通道优先级最高（位于车体正下方，几何上属于走行部）
    const ucMin = toWorld({ u: UNDERCAR_ZONE.u[0], v: 0, w: UNDERCAR_ZONE.w[0] })
    const ucMax = toWorld({ u: UNDERCAR_ZONE.u[1], v: 0, w: UNDERCAR_ZONE.w[1] })
    if (p.x >= ucMin.x && p.x <= ucMax.x && p.z >= ucMin.z && p.z <= ucMax.z) return 'running-gear'

    const order = ['coupler', 'cab', 'running-gear', 'body-side']
    for (const id of order) {
      for (const z of this.zones) {
        if (z.id !== id) continue
        if (p.x < z.box.min.x || p.x > z.box.max.x) continue
        if (p.z < z.box.min.z || p.z > z.box.max.z) continue
        return id
      }
    }
    return 'outside'
  }

  /** 是否在车下通道内（蹲下检查车下的判定） */
  inUndercarChannel(position) {
    const p = this._tmp.set(position.x, position.y, position.z)
    const ucMin = toWorld({ u: UNDERCAR_ZONE.u[0], v: 0, w: UNDERCAR_ZONE.w[0] })
    const ucMax = toWorld({ u: UNDERCAR_ZONE.u[1], v: 0, w: UNDERCAR_ZONE.w[1] })
    return p.x >= ucMin.x && p.x <= ucMax.x && p.z >= ucMin.z && p.z <= ucMax.z
  }

  /** 当前高度能否站进某点（用于站立/蹲下切换时的合法性判断） */
  canStandAt(position, height) {
    return !this._hitAny(position.x, position.y, position.z, height)
  }

  // ───────────────────────── 交互代理 ─────────────────────────
  /** 由零部件配置注册低复杂度交互代理（同时作为其专属碰撞代理） */
  registerInteractionProxies(parts) {
    this.interactionProxies = parts.map((p) => {
      const [sx, sy, sz] = p.proxySize
      const c = p.centerWorld
      const sign = p.side === 'right' ? 1 : p.side === 'left' ? -1 : 0
      // 左右侧部件的横向代理中心按 side 偏移（配置里 dz 已含符号，这里保持一致）
      const cz = p.side === 'both' ? c.z : c.z
      void sign
      const b = box(c.x - sx / 2, c.y - sy / 2, cz - sz / 2, c.x + sx / 2, c.y + sy / 2, cz + sz / 2)
      const r = this.playerRadius
      return {
        partId: p.partId,
        part: p,
        box: b,
        expanded: new THREE.Box3(
          new THREE.Vector3(b.min.x - r, b.min.y, b.min.z - r),
          new THREE.Vector3(b.max.x + r, b.max.y, b.max.z + r),
        ),
      }
    })
    if (this.debugGroup.visible) this._rebuildDebug()
    return this.interactionProxies
  }

  // ───────────────────────── 调试可视化 ─────────────────────────
  setDebug(on) {
    this.debugGroup.visible = Boolean(on)
    if (on && !this._debugBuilt) this._rebuildDebug()
    return this.debugGroup.visible
  }
  get debugEnabled() { return this.debugGroup.visible }

  _rebuildDebug() {
    while (this.debugGroup.children.length) {
      const c = this.debugGroup.children.pop()
      c.geometry?.dispose?.()
      c.material?.dispose?.()
    }
    const mkBox = (b, color, opacity = 0.85) => {
      const s = b.getSize(new THREE.Vector3())
      const c = b.getCenter(new THREE.Vector3())
      const g = new THREE.BoxGeometry(Math.max(s.x, 1e-3), Math.max(s.y, 1e-3), Math.max(s.z, 1e-3))
      const m = new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity })
      const mesh = new THREE.Mesh(g, m)
      mesh.position.copy(c)
      return mesh
    }
    // 碰撞代理：红
    for (const c of this.colliders) this.debugGroup.add(mkBox(c.box, 0xff5a5a, 0.55))
    // 交互代理：青
    for (const p of this.interactionProxies) this.debugGroup.add(mkBox(p.box, 0x38d8ff, 0.75))
    // 分区：黄（线框，仅轮廓）
    for (const z of this.zones) this.debugGroup.add(mkBox(z.box, 0xffd24a, 0.18))
    this._debugBuilt = true
  }

  /** 导出碰撞代理清单（用于自动生成对照表文档） */
  describeColliders() {
    return this.colliders.map((c) => ({
      id: c.id,
      kind: c.kind,
      label: c.label,
      min: c.box.min.toArray(),
      max: c.box.max.toArray(),
      size: c.size.toArray(),
      note: c.note ?? '',
    }))
  }

  dispose() {
    while (this.debugGroup.children.length) {
      const c = this.debugGroup.children.pop()
      c.geometry?.dispose?.()
      c.material?.dispose?.()
    }
    this.colliders.length = 0
    this.zones.length = 0
    this.interactionProxies.length = 0
  }
}

export function createLocomotiveCollisionSystem(opts) {
  return new LocomotiveCollisionSystem(opts)
}
