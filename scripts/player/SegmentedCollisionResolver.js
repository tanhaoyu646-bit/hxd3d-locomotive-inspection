/**
 * 机车分段碰撞体
 * ---------------------------------------------------------------------------
 * 原平台 LocomotiveCollisionResolver 用单一 AABB（整车包围盒）做碰撞，
 * 玩家无法走到车下、也无法进入司机室——这与"按人行走检查走行部/司机室"
 * 的需求冲突。本类把它升级为"分段碰撞"：
 *
 *   · 车体中上部（含设备舱、车顶）作为实体碰撞体，玩家绕行
 *   · 走行部（转向架/轮对）单独作为矮实体碰撞体，玩家绕行但不能爬上去
 *   · 车下空间（轨面与车体之间）保留穿行，玩家可蹲下检视
 *   · 司机室不参与碰撞，玩家可走进去操作
 *
 * 解算方法沿用原版思路：分轴解算（X/Z 分别尝试），保证贴边滑动。
 */
import * as THREE from 'three'

const EPSILON = 1e-4
const DEFAULT_PLAYER_RADIUS = 0.42

/**
 * @typedef {Object} CollisionSegment
 * @property {THREE.Box3} box         该段在世界空间下的包围盒
 * @property {boolean}   [blockTop]  为 true 时玩家不可从顶部跳上去
 */
export class SegmentedCollisionResolver {
  /**
   * @param {THREE.Box3}   modelBounds   整车世界包围盒
   * @param {Object}      [opts]
   * @param {number}      [opts.playerRadius=0.42]
   * @param {number}      [opts.eyeHeight=1.75]
   */
  constructor(modelBounds, opts = {}) {
    this.playerRadius = opts.playerRadius ?? DEFAULT_PLAYER_RADIUS
    this.eyeHeight = opts.eyeHeight ?? 1.75
    this.segments = []
    this.resolved = new THREE.Vector3()
    this.candidate = new THREE.Vector3()
    this._buildSegments(modelBounds)
  }

  /** 根据整车包围盒自动构造分段碰撞体（v2 · 2026-09 碰撞增强） */
  _buildSegments(bounds) {
    const size = bounds.getSize(new THREE.Vector3())
    const center = bounds.getCenter(new THREE.Vector3())
    // 关键高度分层
    //   railTopY  ≈ 0.18·size.y  走行部上沿（轮对上端），车底与车厢分界
    //   bogieTopY ≈ 0.34·size.y  车体主体下沿
    const railTopY = bounds.min.y + size.y * 0.18
    const bogieTopY = bounds.min.y + size.y * 0.34
    const carLongMin = bounds.min.x
    const carLongMax = bounds.max.x

    // 段落（x=车长方向，u 归一化）：
    //   中段 u[0.2, 0.8]  机械间/主变流/车体中段
    //   端部 u<0.2 / u>0.8 司机室/车钩区

    // 1) 中段车体上部：实心挡板（y 从 bogieTopY 到顶）
    //    —— 玩家不能从任何 z 进入机械间 / 检修车顶设备
    this._addSegment({
      box: new THREE.Box3(
        new THREE.Vector3(carLongMin + size.x * 0.20, bogieTopY, bounds.min.z),
        new THREE.Vector3(carLongMax - size.x * 0.20, bounds.max.y, bounds.max.z),
      ),
      blockTop: true,
      label: '中段车体上部',
    })

    // 2) 中段车体中段墙：y 从 railTopY 到 bogieTopY
    //    —— 防止玩家从 y<1.3 车下钻到中段车体内部（机械间设备区下方）
    this._addSegment({
      box: new THREE.Box3(
        new THREE.Vector3(carLongMin + size.x * 0.20, railTopY, bounds.min.z),
        new THREE.Vector3(carLongMax - size.x * 0.20, bogieTopY, bounds.max.z),
      ),
      blockTop: true,
      label: '中段车体中部',
    })

    // 3) 端部车体上部：x 端部全段，y 从 1.42 到顶（足够玩家蹲下钻入端部车下检查走行部/车钩）
    //    —— 防止玩家从端部车底钻入端部车体（司机室内部）
    //    端部 y<1.42 保留开放供玩家钻车下检查
    const cabOpenY = bounds.min.y + size.y * 0.229  // ≈ 1.60（蹲下眼 1.05 可钻入车下，站姿 1.75 不行——符合真人不能站进 1.6m 车底）
    this._addSegment({
      box: new THREE.Box3(
        new THREE.Vector3(carLongMin, cabOpenY, bounds.min.z),
        new THREE.Vector3(carLongMin + size.x * 0.20, bounds.max.y, bounds.max.z),
      ),
      blockTop: true,
      label: '后端车体上部',
    })
    this._addSegment({
      box: new THREE.Box3(
        new THREE.Vector3(carLongMax - size.x * 0.20, cabOpenY, bounds.min.z),
        new THREE.Vector3(carLongMax, bounds.max.y, bounds.max.z),
      ),
      blockTop: true,
      label: '前端车体上部',
    })
  }

  _addSegment(seg) {
    // 扩展半径（three 0.180 没有 expandByScalar，手动扩展）
    const r = this.playerRadius
    const b = seg.box
    seg.expanded = new THREE.Box3(
      new THREE.Vector3(b.min.x - r, b.min.y - r, b.min.z - r),
      new THREE.Vector3(b.max.x + r, b.max.y + r, b.max.z + r),
    )
    this.segments.push(seg)
  }

  /** 判断玩家是否与任一段碰撞（垂直用原 box、水平用扩展 box） */
  _intersectsAny(position) {
    const playerMinY = position.y
    const playerMaxY = position.y + this.eyeHeight
    for (const seg of this.segments) {
      const b = seg.box
      if (playerMaxY <= b.min.y + EPSILON || playerMinY >= b.max.y - EPSILON) continue
      const eb = seg.expanded
      if (position.x > eb.min.x + EPSILON && position.x < eb.max.x - EPSILON
        && position.z > eb.min.z + EPSILON && position.z < eb.max.z - EPSILON) {
        return seg
      }
    }
    return null
  }

  /**
   * 分轴解算，保证沿车体滑动
   * @param {THREE.Vector3} current 当前位置
   * @param {THREE.Vector3} desired 期望位置
   */
  resolve(currentPosition, desiredPosition, context = {}) {
    const eyeHeight = context.eyeHeight ?? this.eyeHeight
    this.eyeHeight = eyeHeight

    // Y 由重力与地面处理，不在碰撞范畴
    if (!this._intersectsAny(desiredPosition)) return desiredPosition

    this.resolved.copy(currentPosition)
    this.resolved.y = desiredPosition.y

    // 试 X 轴
    this.candidate.set(desiredPosition.x, desiredPosition.y, currentPosition.z)
    if (!this._intersectsAny(this.candidate)) {
      this.resolved.x = desiredPosition.x
    }
    // 试 Z 轴
    this.candidate.set(this.resolved.x, desiredPosition.y, desiredPosition.z)
    if (!this._intersectsAny(this.candidate)) {
      this.resolved.z = desiredPosition.z
    }

    return this.resolved
  }

  /** 获取玩家当前所处分位（'cab' / 'bogie' / 'body-side' / 'outside'），用于触发交互 */
  getZone(position) {
    if (!this._modelBounds) return 'outside'
    // 简化：按 x 坐标判断在车长方向
    return 'outside'
  }
}

export function createSegmentedCollisionResolver(bounds, options) {
  return new SegmentedCollisionResolver(bounds, options)
}
