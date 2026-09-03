/**
 * 走行部零部件检查交互状态机
 * ---------------------------------------------------------------------------
 * 把原来的「靠近即提示按 E」升级为显式的 8 步「接近—观察—确认」流程：
 *
 *   1 locked        当前检查步骤未解锁
 *   2 off-position  未到达该部件允许的检查区域
 *   3 too-far       与目标距离不满足要求
 *   4 not-facing    视线朝向不满足要求
 *   5 occluded      中间有车体或其他部件遮挡
 *   6 ready         ↑ 全部满足，按 E / 手机「交互」键进入检视
 *   7 inspecting    检视中：观察故障标记或完成指定检查动作
 *   8 judged        填写/选择结果后，才记录为合格或异常
 *
 * 关键约束
 *   · 不允许「靠近即自动完成」——第 7 步必须真实观察，第 8 步必须提交结果
 *   · 右侧检查卡点击只做「定位/提示」，不推进状态机的第 6 步之后
 *   · 每一步都有可展示的文案，手机端可显示「部件名称 + 距离 + 交互条件」
 * ---------------------------------------------------------------------------
 */
import * as THREE from 'three'
import { toWorld } from './runningGearParts.js'

export const STAGE = Object.freeze({
  LOCKED: 'locked',
  OFF_POSITION: 'off-position',
  TOO_FAR: 'too-far',
  NOT_FACING: 'not-facing',
  OCCLUDED: 'occluded',
  READY: 'ready',
  INSPECTING: 'inspecting',
  JUDGED: 'judged',
})

/** 阶段顺序与展示信息 */
export const STAGE_META = Object.freeze({
  [STAGE.LOCKED]: { order: 1, label: '未解锁', hint: '请先完成前面的检查步骤' },
  [STAGE.OFF_POSITION]: { order: 2, label: '未到位', hint: '请走到该部件允许的检查区域' },
  [STAGE.TOO_FAR]: { order: 3, label: '距离过远', hint: '请再靠近一些' },
  [STAGE.NOT_FACING]: { order: 4, label: '未朝向', hint: '请面向该部件' },
  [STAGE.OCCLUDED]: { order: 5, label: '视线受阻', hint: '有部件挡住视线，请换个角度' },
  [STAGE.READY]: { order: 6, label: '可检视', hint: '按 E 或点「交互」键进入检视' },
  [STAGE.INSPECTING]: { order: 7, label: '检视中', hint: '旋转视角寻找故障标记，或确认无异常' },
  [STAGE.JUDGED]: { order: 8, label: '已判定', hint: '本部件检查已完成' },
})

const _v = new THREE.Vector3()

/** 点是否落在归一化区域内（区域允许越界） */
function inRegion(pos, region) {
  const a = toWorld({ u: region.u[0], v: region.v[0], w: region.w[0] })
  const b = toWorld({ u: region.u[1], v: region.v[1], w: region.w[1] })
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x)
  const minZ = Math.min(a.z, b.z), maxZ = Math.max(a.z, b.z)
  // 纵向（v）只做宽松校验：玩家在地面或蹲下均在允许范围
  return pos.x >= minX && pos.x <= maxX && pos.z >= minZ && pos.z <= maxZ
}

export function createPartInteractionFSM(options = {}) {
  const {
    /** @type {(itemId:string)=>boolean} 检查项是否已解锁 */
    isItemUnlocked = () => true,
    /** @type {(part:Object, from:THREE.Vector3)=>boolean} 视线遮挡检测 */
    isOccluded = () => false,
  } = options

  /** partId -> 运行时检视状态 */
  const runtime = new Map()

  function stateOf(partId) {
    if (!runtime.has(partId)) {
      runtime.set(partId, {
        stage: STAGE.LOCKED,
        inspected: false,
        observedMarkers: new Set(),
        /** 学生主动确认「未发现异常」后仍需提交结果 */
        noFaultConfirmed: false,
        result: null,
        note: '',
        enteredAt: 0,
        judgedAt: 0,
      })
    }
    return runtime.get(partId)
  }

  /**
   * 评估某部件当前处于哪个阶段
   * @param {Object} part 零部件配置
   * @param {Object} ctx { position, eyeHeight, crouching, forward }
   * @returns {Object}
   */
  /** 同时接受零部件配置与检查点对象（检查点挂着 .part） */
  const unwrap = (t) => (t && t.part ? t.part : t)

  function evaluate(target, ctx, opts = {}) {
    const part = unwrap(target)
    const st = stateOf(part.partId)
    /** 收敛返回：统一带上原始 target，便于调用方取检查点对象 */
    const finish = (stage, conditions, extra = {}) =>
      build(part, st, stage, ctx, conditions, { ...extra, target })

    if (st.result) return finish(STAGE.JUDGED, [])
    if (st.inspected) return finish(STAGE.INSPECTING, [])

    const conditions = []
    const center = _v.set(part.centerWorld.x, part.centerWorld.y, part.centerWorld.z)

    // ① 检查项是否已解锁
    const unlocked = isItemUnlocked(part.itemId)
    conditions.push({
      code: 'unlocked', label: '步骤已解锁', met: unlocked,
      detail: unlocked ? '' : '请先完成前面的检查步骤',
    })
    if (!unlocked) return finish(STAGE.LOCKED, conditions)

    // ② 是否到达该部件允许的检查区域
    const zone = (part.zones ?? []).find((z) => inRegion(ctx.position, z.region))
    conditions.push({
      code: 'inZone', label: '到达检查区域', met: Boolean(zone),
      detail: zone ? zone.label : '请走到车体外侧对应站位',
    })
    if (!zone) return finish(STAGE.OFF_POSITION, conditions)

    // 蹲下要求：区域要求蹲下，或部件本身要求蹲下
    const needCrouch = zone.requireCrouch || part.requireCrouch
    const crouchOK = !needCrouch || ctx.crouching
    if (needCrouch) {
      conditions.push({
        code: 'crouch', label: '需蹲下检查', met: crouchOK,
        detail: crouchOK ? '' : '请按住蹲下键（C / 手机「下蹲」）',
      })
      if (!crouchOK) return finish(STAGE.OFF_POSITION, conditions)
    }

    // ③ 距离
    const dx = center.x - ctx.position.x
    const dz = center.z - ctx.position.z
    const distance = Math.hypot(dx, dz)
    const maxDistance = part.approach?.maxDistance ?? 3.0
    const distOK = distance <= maxDistance
    conditions.push({
      code: 'distance', label: '距离满足', met: distOK,
      detail: `${distance.toFixed(1)}m / 需 ≤${maxDistance.toFixed(1)}m`,
    })
    if (!distOK) return finish(STAGE.TOO_FAR, conditions)

    // ④ 朝向
    const facing = distance < 0.3 ? 1 : (ctx.forward.x * (dx / distance) + ctx.forward.z * (dz / distance))
    const facingThreshold = part.approach?.facing ?? 0.5
    const facingOK = facing >= facingThreshold
    conditions.push({
      code: 'facing', label: '朝向部件', met: facingOK,
      detail: facingOK ? '' : '请转身面向该部件',
    })
    if (!facingOK) return finish(STAGE.NOT_FACING, conditions)

    // ⑤ 遮挡（每帧靠近检测可跳过，仅在按交互键时判定，避免频繁射线检测卡顿）
    const eye = new THREE.Vector3(ctx.position.x, ctx.position.y + ctx.eyeHeight, ctx.position.z)
    const blocked = opts.skipOcclusion ? false : isOccluded(part, eye)
    conditions.push({
      code: 'visible', label: '视线通畅', met: !blocked,
      detail: blocked ? '有部件挡住视线，请换个角度' : '',
    })
    if (blocked) return finish(STAGE.OCCLUDED, conditions)

    return finish(STAGE.READY, conditions, { distance, facing, zone })
  }

  function build(part, st, stage, ctx, conditions, extra = {}) {
    const center = part.centerWorld
    const distance = extra.distance
      ?? Math.hypot(center.x - ctx.position.x, center.z - ctx.position.z)
    st.stage = stage
    return {
      part,
      partId: part.partId,
      /** 传入的原始对象（检查点或零部件），供调用方取用 */
      target: extra.target ?? part,
      stage,
      stageMeta: STAGE_META[stage],
      /** 只有 READY 才允许进入检视 */
      canEnter: stage === STAGE.READY,
      conditions,
      unmet: conditions.filter((c) => !c.met),
      distance,
      facing: extra.facing ?? null,
      zone: extra.zone ?? null,
      runtime: st,
    }
  }

  // ───────────────────────── 状态推进 ─────────────────────────
  /** 第 6→7 步：按交互键进入检视（仅 READY 允许） */
  function beginInspect(part) {
    const st = stateOf(part.partId)
    st.inspected = true
    st.stage = STAGE.INSPECTING
    st.enteredAt = Date.now()
    return st
  }

  /** 退出检视但尚未提交最终结果：允许稍后从同一部件继续，不丢已发现标记。 */
  function cancelInspect(partId) {
    const st = stateOf(partId)
    if (!st.result) {
      st.inspected = false
      st.stage = STAGE.READY
    }
    return st
  }

  /** 第 7 步：观察到一个故障标记 */
  function observeMarker(partId, markerKey) {
    const st = stateOf(partId)
    st.observedMarkers.add(markerKey)
    return st
  }

  /** 第 7 步：学生确认未发现异常（仍须走第 8 步提交） */
  function confirmNoFault(partId) {
    const st = stateOf(partId)
    st.noFaultConfirmed = true
    return st
  }

  /**
   * 第 7 步是否完成：发现全部标记，或显式确认无异常
   * @param {number} markerTotal 该部件的故障标记总数
   */
  function isObservationDone(partId, markerTotal) {
    const st = stateOf(partId)
    if (markerTotal > 0) return st.observedMarkers.size >= markerTotal
    return st.noFaultConfirmed
  }

  /** 第 8 步：提交结果后才记录合格/异常 */
  function judge(partId, result) {
    const st = stateOf(partId)
    st.result = result // { status:'ok'|'ng', note, action, level, faultsFound, faultsTotal }
    st.stage = STAGE.JUDGED
    st.judgedAt = Date.now()
    return st
  }

  /** 重置某部件（清空重检时使用） */
  function resetPart(partId) {
    runtime.delete(partId)
  }
  function resetAll() { runtime.clear() }

  /** 供外部读取运行时状态（评分/汇总用） */
  function getRuntime(partId) { return runtime.get(partId) ?? null }

  /**
   * 找出当前「最接近可交互」的部件，用于手机端提示与自动定位
   * @param {Array} parts
   * @param {Object} ctx
   * @returns {Object|null}
   */
  function pickBest(parts, ctx) {
    let best = null
    for (const part of parts) {
      const ev = evaluate(part, ctx)
      if (!best) { best = ev; continue }
      // 优先级：阶段越靠前（越接近可交互）越好；同阶段比距离
      const a = STAGE_META[ev.stage].order
      const b = STAGE_META[best.stage].order
      if (a > b) best = ev
      else if (a === b && ev.distance < best.distance) best = ev
    }
    return best
  }

  return {
    STAGE, STAGE_META,
    evaluate, beginInspect, cancelInspect, observeMarker, confirmNoFault,
    isObservationDone, judge, resetPart, resetAll, getRuntime, pickBest,
  }
}
