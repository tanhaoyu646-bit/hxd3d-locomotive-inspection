const memory = new Map()
globalThis.localStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
}

const {
  createPeerScenario,
  loadPeerScenario,
  savePeerScenario,
  allowedFaultTypes,
  nextFaultType,
  upsertScenarioFault,
  updateScenarioFaultType,
  removeLastScenarioFault,
  lockPeerScenario,
} = await import('../scripts/peerScenario.js')

let passed = 0
let failed = 0
function check(label, condition) {
  if (condition) {
    passed += 1
    console.log(`✓ ${label}`)
  } else {
    failed += 1
    console.error(`✗ ${label}`)
  }
}

const point = {
  id: 'rg-axle-1-left-axlebox',
  part: { judge: { faults: [{ faultType: 'crack' }, { faultType: 'loose-bolt' }, { faultType: 'leak' }] } },
}
let scenario = savePeerScenario(createPeerScenario({ name: '出题同学', id: 'A01' }))
check('创建草稿', scenario?.status === 'draft')
check('部件限定故障类型', allowedFaultTypes(point).join(',') === 'crack,loose-bolt,leak')
check('故障类型循环', nextFaultType(point, 'crack') === 'loose-bolt')

const baseFault = {
  faultId: `F-${point.id}`,
  pointId: point.id,
  partId: point.id,
  itemId: 'bogie-2',
  faultType: 'crack',
  anchor: { position: [1, 2, 3], normal: [0, 0, 1], tangent: [1, 0, 0] },
  glyph: { size: 0.072 },
}
scenario = upsertScenarioFault(scenario, baseFault)
scenario = upsertScenarioFault(scenario, { ...baseFault, anchor: { ...baseFault.anchor, position: [4, 5, 6] } })
check('同一检查点只保留一处故障', scenario.faults.length === 1)
check('重新点击可更新表面位置', scenario.faults[0].anchor.position[0] === 4)
scenario = updateScenarioFaultType(scenario, baseFault.faultId, 'loose-bolt')
check('可切换故障类型', scenario.faults[0].faultType === 'loose-bolt')
check('切换类型后清除旧轮廓顶点', !scenario.faults[0].anchor.vertices)
check('草稿可从本机恢复', loadPeerScenario()?.faults?.length === 1)

scenario = lockPeerScenario(scenario)
check('题目可锁定交给答题人', scenario?.status === 'locked')
const unchanged = removeLastScenarioFault(scenario)
check('锁定后不能删改答案', unchanged.faults.length === 1)

console.log(`\n同伴出题状态断言通过 ${passed} · 失败 ${failed}`)
if (failed) process.exit(1)
