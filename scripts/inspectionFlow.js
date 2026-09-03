/**
 * 检查流程显式状态机（skill 约束 1：显式状态机控制教学顺序）
 * ---------------------------------------------------------------------------
 * 把"8 部位自由勾选"升级为"按检查路线的阶段推进"：
 *
 *   · 每个部位 = 一个阶段（stage），阶段完成条件 = 该部位所有检查项都有判定
 *     （合格 / 异常 任一状态都算"已检查"，未填 = 待检）
 *   · 当前阶段 = 正在检查的部位
 *   · 下一部位：校验当前阶段完成，未完成则返回原因（不越级）
 *   · 部位解锁：前面所有阶段完成才解锁，但允许回看已完成的阶段
 *
 * 软引导策略：不强制锁死点击，但"下一部位"按钮和部位解锁状态体现阶段推进；
 * 越级点击给提示，由上层决定是否跳转。
 *
 * 与状态数据解耦：通过 isItemJudged(id) 回调读取检查判定，保持数据同源。
 */

/**
 * @param {Array} routes INSPECTION_ROUTES
 * @param {Object} deps
 * @param {(id:string)=>boolean} deps.isItemJudged 检查项是否已有判定
 */
export function createInspectionFlow(routes, { isItemJudged }) {
  let current = 0

  /** 某阶段的完成统计 */
  function stageOf(index) {
    const route = routes[index]
    if (!route) return null
    let judged = 0
    let ng = 0
    for (const item of route.items) {
      const rec = isItemJudged(item.id)
      if (rec) {
        judged += 1
        if (rec === 'ng') ng += 1
      }
    }
    return {
      route,
      index,
      judged,
      ng,
      total: route.items.length,
      completed: judged === route.items.length,
      remaining: route.items.length - judged,
    }
  }

  /** 是否可进入某阶段（前面所有阶段已完成） */
  function canEnter(index) {
    for (let i = 0; i < index; i += 1) {
      if (!stageOf(i).completed) return false
    }
    return true
  }

  /** 跳转到某阶段（允许回看已完成/当前，向前跳需要解锁） */
  function goTo(index) {
    if (index < 0 || index >= routes.length) return { ok: false, reason: '超出范围' }
    if (index > current && !canEnter(index)) {
      const firstPending = routes.findIndex((_, i) => i < index && !stageOf(i).completed)
      const pendingName = firstPending >= 0 ? routes[firstPending].shortName : ''
      return {
        ok: false,
        reason: pendingName ? `请先完成「${pendingName}」的检查` : '请按检查路线顺序逐项检查',
      }
    }
    current = index
    return { ok: true, stage: current, stageInfo: stageOf(current) }
  }

  /** 推进到下一阶段（校验当前阶段完成） */
  function advance() {
    const cur = stageOf(current)
    if (!cur.completed) {
      return {
        ok: false,
        reason: `「${cur.route.shortName}」还有 ${cur.remaining} 项未检查`,
        stage: current,
      }
    }
    if (current >= routes.length - 1) {
      return { ok: false, reason: '已是最后一个检查部位', stage: current }
    }
    current += 1
    return { ok: true, stage: current, stageInfo: stageOf(current) }
  }

  /** 全部阶段是否完成 */
  function allCompleted() {
    return routes.every((_, i) => stageOf(i).completed)
  }

  return {
    getCurrent: () => current,
    setCurrent: (i) => { if (i >= 0 && i < routes.length) current = i },
    stageOf,
    canEnter,
    goTo,
    advance,
    allCompleted,
    get total() { return routes.length },
  }
}
