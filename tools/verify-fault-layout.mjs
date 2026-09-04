/**
 * 假设故障外表面布局校验。
 * 验证本轮每个故障点：配置存在、只生成一枚标记，且标记法线外侧 25cm 内能命中模型。
 * 用法：node tools/verify-fault-layout.mjs
 */
import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from '../lib/three/addons/loaders/GLTFLoader.js'
import { INSPECTION_ROUTES, buildItemIndex } from '../scripts/inspectionData.js'
import { getRunningGearParts, getRunningGearItemIds } from '../scripts/parts/runningGearParts.js'
import { SCENARIO_FAULT_POINT_IDS } from '../scripts/faultScenario.js'
import { buildInspectionPoints, buildPartPoints, paintFaultMarkersOnModel, paintFaultMarkersOnPart } from '../scripts/partInspection.js'

globalThis.self = globalThis
const modelPath = new URL('../models/hxd3d-integration-spatial.glb', import.meta.url)
const bytes = fs.readFileSync(modelPath)
const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
// Node 下不解码浏览器纹理；这些纹理警告与几何射线校验无关，保持输出可读。
console.warn = () => {}
console.error = () => {}
const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(data, '', resolve, reject))
const root = gltf.scene
root.updateMatrixWorld(true)
const bounds = new THREE.Box3().setFromObject(root)
const active = INSPECTION_ROUTES.filter((route) => ['bogie', 'coupler', 'signal'].includes(route.id))
const excluded = new Set(getRunningGearItemIds())
const regionPoints = buildInspectionPoints(active, bounds, { excludeItems: excluded })
const bogieRoute = active.find((route) => route.id === 'bogie')
const points = [...regionPoints, ...buildPartPoints(getRunningGearParts(), bogieRoute, buildItemIndex())]
const index = new Map(points.map((p) => [p.id, p]))
const raycaster = new THREE.Raycaster()
let pass = 0
let fail = 0

for (const id of SCENARIO_FAULT_POINT_IDS) {
  const point = index.get(id)
  if (!point) {
    console.log(`✗ ${id}：不存在对应检查点`)
    fail += 1
    continue
  }
  const markers = point.isPartPoint
    ? paintFaultMarkersOnPart(root, point, { seed: 0.314159 })
    : paintFaultMarkersOnModel(root, point, { seed: 0.314159 })
  if (markers.length !== 1) {
    console.log(`✗ ${id}：应只生成 1 枚故障标记，实际 ${markers.length}`)
    fail += 1
    continue
  }
  const marker = markers[0]
  const origin = marker.proxy.position.clone().addScaledVector(marker.normal, 0.25)
  raycaster.set(origin, marker.normal.clone().negate())
  raycaster.far = 0.35
  const hit = raycaster.intersectObject(root, true)[0]
  if (!hit) {
    console.log(`✗ ${id}：标记未贴合模型外表面`)
    fail += 1
    continue
  }
  console.log(`✓ ${id}：单标记，外表面贴合 ${hit.distance.toFixed(3)}m`)
  pass += 1
}

console.log(`\n故障布局断言通过 ${pass} · 失败 ${fail}`)
process.exit(fail ? 1 : 0)
