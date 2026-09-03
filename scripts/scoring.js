/**
 * 检查作业评分（skill 约束 3、6：模块分离 + 数据同源）
 * ---------------------------------------------------------------------------
 * 纯函数评分：不直接读 state，依赖通过参数注入；
 * 数据源（routes、items、统计）保持单一来源。
 *
 * 评分维度：
 *   完成度 50% + 故障检出率 50%
 * 关键项（A 级）存在异常但未登记处置方式/时限 → 评定不合格
 */

/**
 * @param {Object} deps
 * @param {Array}  deps.routes      INSPECTION_ROUTES
 * @param {Function} deps.getItem   (itemId) => record | undefined
 * @param {Object}  deps.globalStats { total, done }
 * @param {Object}  deps.faultStats  { found, total, rate }
 * @returns {{total:number, pass:boolean, blocking:boolean, handled:number}}
 */
export function computeScore({ routes, getItem, globalStats, faultStats }) {
  // 完成度
  const complete = globalStats.total ? globalStats.done / globalStats.total : 0
  // 故障检出率
  const detect = faultStats.rate

  // 异常项收集与处置完整度
  const issues = routes.flatMap((r) =>
    r.items.filter((i) => getItem(i.id)?.status === 'ng')
  )
  const handled = issues.length
    ? issues.filter((i) => {
        const rec = getItem(i.id)
        return rec?.action && rec?.level
      }).length / issues.length
    : 1

  const total = Math.round(complete * 50 + detect * 50)

  // 关键项（A 级）异常但未登记处置 → 阻断出库
  const blocking = issues.some((i) => {
    if (i.level !== 'A') return false
    const rec = getItem(i.id)
    return !(rec?.action && rec?.level)
  })

  return {
    total,
    pass: total >= 60 && !blocking,
    blocking,
    handled,
  }
}
