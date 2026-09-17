import { createFaultMarkerFromRecord, FAULT_TYPES } from '../scripts/partInspection.js'

let passed = 0
let failed = 0
function check(label, condition) {
  if (condition) { passed += 1; console.log(`✓ ${label}`) }
  else { failed += 1; console.error(`✗ ${label}`) }
}

const point = { id: 'rg-axle-1-left-axlebox', part: { partId: 'rg-axle-1-left-axlebox' } }
for (const faultType of Object.keys(FAULT_TYPES)) {
  const marker = createFaultMarkerFromRecord(point, {
    faultId: `F-${faultType}`,
    pointId: point.id,
    faultType,
    anchor: { position: [1, 2, 3], normal: [0, 0, 1], tangent: [1, 0, 0] },
    glyph: { size: 0.072 },
  })
  check(`${faultType} 可从题目记录重建`, Boolean(marker?.line && marker?.proxy))
  check(`${faultType} 保留唯一故障编号`, marker?.faultId === `F-${faultType}`)
  check(`${faultType} 拾取代理与可见符号绑定`, marker?.proxy?.userData?.marker === marker?.line)
  marker?.line?.geometry?.dispose?.(); marker?.line?.material?.dispose?.()
  marker?.proxy?.geometry?.dispose?.(); marker?.proxy?.material?.dispose?.()
}

console.log(`\n动态故障标记断言通过 ${passed} · 失败 ${failed}`)
if (failed) process.exit(1)
