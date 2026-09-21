import { computeScore } from '../scripts/scoring.js'

let failed = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`✓ ${label}${detail ? ` · ${detail}` : ''}`)
  else { failed += 1; console.error(`✗ ${label}${detail ? ` · ${detail}` : ''}`) }
}

const route = (items) => ({ id: 'test', shortName: '测试部位', items })

// 一处基础制动故障不应使同一检查项内另一处已检查零部件显示 0 分。
const distributed = computeScore({
  routes: [route([{ id: 'bogie-6', name: '基础制动装置', level: 'A' }])],
  getItem: () => ({ partRecords: { normal: { status: 'ok', faultsTotal: 0, faultsFound: 0 } } }),
  getPoints: () => [{ id: 'normal', faultTotal: 0 }, { id: 'fault', faultTotal: 1 }],
})
const distributedItem = distributed.items[0]
check('正常实体在同项其他实体有故障时仍获得独立分值', distributedItem.earned === 3.5, `earned=${distributedItem.earned}`)
check('未发现关键故障仍触发不合格限制', distributed.blocking === true)

const found = computeScore({
  routes: [route([{ id: 'bogie-6', name: '基础制动装置', level: 'A' }])],
  getItem: () => ({
    partRecords: {
      normal: { status: 'ok', faultsTotal: 0, faultsFound: 0 },
      fault: { status: 'ng', faultsTotal: 1, faultsFound: 1 },
    },
    faultReports: [{ pointId: 'fault', accuracy: { score: 100 } }],
  }),
  getPoints: () => [{ id: 'normal', faultTotal: 0 }, { id: 'fault', faultTotal: 1 }],
})
check('正常实体和正确上报故障可共同取得该项满分', found.items[0].earned === 7, `earned=${found.items[0].earned}`)
check('关键故障已检出且各实体完成后解除不合格限制', found.blocking === false)

const roof = computeScore({
  routes: [route([{ id: 'roof-1', name: '受电弓滑板与弓头', level: 'A' }])],
  getItem: () => ({ partRecords: { roof: { status: 'ok' } } }),
  getPoints: () => [{ id: 'roof', faultTotal: 0 }],
})
check('车顶检查项保留训练记录但不计入100分', roof.items[0].scored === false && roof.rawMax === 0)

console.log(`\n实体评分断言通过 ${4 - failed} · 失败 ${failed}`)
if (failed) process.exit(1)
