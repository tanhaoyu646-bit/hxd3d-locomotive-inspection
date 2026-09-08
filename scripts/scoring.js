/** 车外检查各课程项分值，合计 100 分。 */
export const ITEM_SCORES = Object.freeze({
  'bogie-1': 8, 'bogie-2': 7, 'bogie-3': 5, 'bogie-4': 5, 'bogie-5': 6, 'bogie-6': 7, 'bogie-7': 4, 'bogie-8': 3,
  'coupler-1': 6, 'coupler-2': 5, 'coupler-3': 4, 'coupler-4': 3, 'coupler-5': 6, 'coupler-6': 6,
  'signal-1': 6, 'signal-5': 5, 'signal-2': 3, 'signal-3': 3, 'signal-4': 2, 'signal-6': 2, 'signal-7': 4,
})

const round1 = (n) => Math.round(n * 10) / 10

/**
 * 逐项评分：正常项按“实体检查覆盖 + 判断”，故障项按“覆盖 + 检出 + 填报准确度”。
 * getPointTotal / getFaultTotal 由三维场景提供，保证重复轴位按实体而不是按文字项点计分。
 */
export function computeScore({ routes, getItem, getPointTotal = () => 1, getFaultTotal = () => 0 }) {
  const items = []
  let rawTotal = 0
  let rawMax = 0
  let blocking = false
  routes.forEach((route) => route.items.forEach((item) => {
    const max = ITEM_SCORES[item.id] ?? 0
    const record = getItem(item.id)
    const pointTotal = Math.max(1, getPointTotal(item.id) || 1)
    const records = Object.values(record?.partRecords ?? {})
    const checked = records.length || (record?.status ? 1 : 0)
    const coverage = Math.min(1, checked / pointTotal)
    const faultTotal = Math.max(0, getFaultTotal(item.id) || record?.faultsTotal || 0)
    const found = Math.min(faultTotal, record?.faultsFound ?? 0)
    const reportScores = (record?.faultReports ?? []).map((r) => Number(r.accuracy?.score ?? 0))
    const reportAccuracy = reportScores.length ? reportScores.reduce((sum, n) => sum + n, 0) / reportScores.length / 100 : 0
    const verdict = record?.status ? 1 : 0
    const earned = faultTotal > 0
      ? max * (coverage * .20 + (faultTotal ? found / faultTotal : 0) * .30 + reportAccuracy * .50)
      : max * (coverage * .60 + verdict * .40)
    if (item.level === 'A' && (!record?.status || (faultTotal > 0 && found < faultTotal))) blocking = true
    rawTotal += earned
    rawMax += max
    items.push({ route, item, record, max, earned: round1(earned), coverage, checked, pointTotal, faultTotal, found, reportAccuracy: Math.round(reportAccuracy * 100) })
  }))
  const total = rawMax ? Math.round(rawTotal / rawMax * 100) : 0
  return { total, pass: total >= 60 && !blocking, blocking, items, rawTotal: round1(rawTotal), rawMax }
}
