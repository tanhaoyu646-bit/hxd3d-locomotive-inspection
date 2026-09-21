/**
 * 计分仅覆盖当前开放的走行部、车钩和端部项目；车顶保留为训练内容但不纳入100分。
 * 每个文本检查项的分值由其实际语义零部件均分，不能因为同项中一处出题故障，
 * 就让其他已检查零部件在成绩单上显示为 0 分。
 */
export const ITEM_SCORES = Object.freeze({
  'bogie-1': 8, 'bogie-2': 7, 'bogie-3': 5, 'bogie-4': 5, 'bogie-5': 6, 'bogie-6': 7, 'bogie-7': 4, 'bogie-8': 3,
  'coupler-1': 6, 'coupler-2': 5, 'coupler-3': 4, 'coupler-4': 3, 'coupler-5': 6, 'coupler-6': 6,
  'signal-1': 6, 'signal-5': 5, 'signal-2': 3, 'signal-3': 3, 'signal-4': 2, 'signal-6': 2, 'signal-7': 4,
})

const round1 = (n) => Math.round(n * 10) / 10

function pointList(item, getPoints, getPointTotal, getFaultTotal) {
  const configured = getPoints?.(item.id) ?? []
  if (configured.length) return configured.map((point) => ({
    id: point.id,
    faultTotal: Math.max(0, Number(point.faultTotal ?? 0)),
  }))
  // 尚未具备三维交互锚点的项目仍允许用检查卡片完成，不因缺少模型锚点失分。
  return [{
    id: '__item__',
    faultTotal: Math.max(0, Number(getFaultTotal(item.id) || 0)),
    fallbackTotal: Math.max(1, Number(getPointTotal(item.id) || 1)),
  }]
}

function reportsForPoint(reports, pointId, pointCount) {
  const direct = reports.filter((report) => report?.pointId === pointId)
  // 兼容 V1.8.2 及更早版本保存的记录：旧记录没有 pointId 时，只有单一实体项才可安全归属。
  if (direct.length || pointCount > 1) return direct
  return reports.filter((report) => !report?.pointId)
}

/**
 * 逐实体评分：
 * - 无故障实体：完成确认即可获得该实体全部份额。
 * - 有故障实体：检查覆盖20%、故障检出30%、活件准确50%。
 * 得分在实体层计算，汇总后仍按原检查项展示。
 */
export function computeScore({ routes, getItem, getPoints = null, getPointTotal = () => 1, getFaultTotal = () => 0 }) {
  const items = []
  let rawTotal = 0
  let rawMax = 0
  let blocking = false

  routes.forEach((route) => route.items.forEach((item) => {
    const max = ITEM_SCORES[item.id] ?? 0
    const record = getItem(item.id)
    const records = record?.partRecords ?? {}
    const reports = record?.faultReports ?? []
    const points = pointList(item, getPoints, getPointTotal, getFaultTotal)
    const pointCount = points.length
    const share = max / pointCount
    let earned = 0
    let checked = 0
    let faultTotal = 0
    let found = 0
    const reportScores = []

    points.forEach((point) => {
      const pointRecord = records[point.id]
        ?? ((point.id === '__item__' && record?.status) ? record : null)
      const pointFaultTotal = Math.max(point.faultTotal, Number(pointRecord?.faultsTotal ?? 0))
      const pointFound = Math.min(pointFaultTotal, Number(pointRecord?.faultsFound ?? 0))
      const isChecked = Boolean(pointRecord?.status)
      const pointReports = reportsForPoint(reports, point.id, pointCount)
      const reportAccuracy = pointReports.length
        ? pointReports.reduce((sum, report) => sum + Number(report?.accuracy?.score ?? 0), 0) / pointReports.length / 100
        : 0

      if (isChecked) checked += 1
      faultTotal += pointFaultTotal
      found += pointFound
      pointReports.forEach((report) => reportScores.push(Number(report?.accuracy?.score ?? 0)))

      if (pointFaultTotal > 0) {
        earned += share * ((isChecked ? .20 : 0) + (pointFound / pointFaultTotal) * .30 + reportAccuracy * .50)
      } else if (isChecked) {
        earned += share
      }

      if (max > 0 && item.level === 'A' && (!isChecked || (pointFaultTotal > 0 && pointFound < pointFaultTotal))) blocking = true
    })

    const reportAccuracy = reportScores.length
      ? Math.round(reportScores.reduce((sum, n) => sum + n, 0) / reportScores.length)
      : 0
    const coverage = pointCount ? checked / pointCount : 0
    rawTotal += earned
    rawMax += max
    items.push({
      route, item, record, max, scored: max > 0, earned: round1(earned), coverage,
      checked, pointTotal: pointCount, faultTotal, found, reportAccuracy,
    })
  }))

  const total = rawMax ? Math.round(rawTotal / rawMax * 100) : 0
  return { total, pass: total >= 60 && !blocking, blocking, items, rawTotal: round1(rawTotal), rawMax }
}
