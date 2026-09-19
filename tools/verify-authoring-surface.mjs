import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from '../lib/three/addons/loaders/GLTFLoader.js'
import { getRunningGearParts } from '../scripts/parts/runningGearParts.js'
import { createAuthoringBox, selectAuthoringHit, conformMarkerGeometry, configureInspectOrbit, findAuthorMarkerNearPointer } from '../scripts/authoringSurface.js'
import { createFaultMarkerFromRecord } from '../scripts/partInspection.js'

let passed = 0
let failed = 0
function check(label, condition, detail = '') {
  if (condition) { passed += 1; console.log(`✓ ${label}${detail ? `  ${detail}` : ''}`) }
  else { failed += 1; console.error(`✗ ${label}${detail ? `  ${detail}` : ''}`) }
}

// 1) 独立出题范围必须比碰撞代理完整，且仍阻止穿透前景物体。
const axlebox = getRunningGearParts().find((part) => part.type === 'axlebox')
const box = createAuthoringBox(axlebox)
const boxSize = box.getSize(new THREE.Vector3())
check('轴箱出题范围独立于碰撞代理', boxSize.x > axlebox.proxySize[0] && boxSize.y > axlebox.proxySize[1] && boxSize.z > axlebox.proxySize[2])
const p0 = box.getCenter(new THREE.Vector3())
const visible = { point: p0.clone(), distance: 2 }
const thinOccluder = { point: p0.clone().add(new THREE.Vector3(2, 0, 0)), distance: 1.98 }
const deepOccluder = { point: p0.clone().add(new THREE.Vector3(2, 0, 0)), distance: 1.4 }
check('近距离数值误差不误判为遮挡', selectAuthoringHit([thinOccluder, visible], box) === visible)
check('明显前景遮挡时禁止穿透设置', selectAuthoringHit([deepOccluder, visible], box) === null)
const controls = {}
configureInspectOrbit(controls, 2)
check('检视视角开放水平360°旋转', controls.minAzimuthAngle === -Infinity && controls.maxAzimuthAngle === Infinity)
check('检视旋转中心禁止平移', controls.enablePan === false)

// 1.1) 出题时仅精确点击已有符号才切换类型；附近的新落点必须允许继续加题。
const pickCamera = new THREE.PerspectiveCamera(60, 2, 0.1, 100)
pickCamera.position.set(0, 0, 5)
pickCamera.lookAt(0, 0, 0)
pickCamera.updateProjectionMatrix()
pickCamera.updateMatrixWorld(true)
const markerA = { faultId: 'A', surfacePoint: new THREE.Vector3(0, 0, 0) }
const pickRect = { left: 0, top: 0, width: 1000, height: 500 }
check('精确点击已有标记可切换类型', findAuthorMarkerNearPointer([markerA], pickCamera, pickRect, 506, 250, 12) === markerA)
check('点击同一零部件的其他位置不会被已有大代理吞掉', findAuthorMarkerNearPointer([markerA], pickCamera, pickRect, 530, 250, 12) === null)

// 2) 在真实 GLB 上验证典型走行部从车外能够命中专用出题范围。
globalThis.self = globalThis
const modelPath = path.resolve('models/hxd3d-integration-spatial.glb')
const bytes = fs.readFileSync(modelPath)
const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
const originalWarn = console.warn
const originalError = console.error
console.warn = () => {}
console.error = () => {}
const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(data, '', resolve, reject))
console.warn = originalWarn
console.error = originalError
const root = gltf.scene
root.updateMatrixWorld(true)
const raycaster = new THREE.Raycaster()
const allParts = getRunningGearParts()
const surfaceFailures = []
for (const part of allParts) {
  const center = new THREE.Vector3(part.centerWorld.x, part.centerWorld.y, part.centerWorld.z)
  const partBox = createAuthoringBox(part)
  const directions = []
  for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) {
    if (x || y || z) directions.push(new THREE.Vector3(x, y, z).normalize())
  }
  let hit = null
  let hitDirection = -1
  let diagnostic = null
  directions.some((outward, index) => {
    raycaster.set(center.clone().addScaledVector(outward, 4), outward.clone().negate())
    raycaster.far = 8
    const hits = raycaster.intersectObject(root, true)
    const candidate = selectAuthoringHit(hits, partBox, 0.08)
    const nearestToBox = hits
      .map((entry) => ({ entry, distance: partBox.distanceToPoint(entry.point) }))
      .sort((a, b) => a.distance - b.distance)[0]
    diagnostic = { hits, nearestToBox }
    if (!candidate) return false
    hit = candidate
    hitDirection = index
    return true
  })
  const detail = hit
    ? `方向 ${hitDirection + 1}，命中距离 ${hit.distance.toFixed(3)}m`
    : `未命中；最近表面距范围 ${(diagnostic?.nearestToBox?.distance ?? -1).toFixed(3)}m`
  if (!hit) surfaceFailures.push(`${part.partId}(${part.shortName})：${detail}`)
}
check('全部走行部零部件至少有一面可设置故障', surfaceFailures.length === 0,
  surfaceFailures.length ? `失败 ${surfaceFailures.length}/${allParts.length}` : `${allParts.length}/${allParts.length}`)
if (surfaceFailures.length) surfaceFailures.forEach((entry) => console.error(`  - ${entry}`))

// 3) 曲面逐顶点吸附：用球面模拟轮缘/端盖，所有点都应贴在曲面约 2.5mm 外。
const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.MeshBasicMaterial())
sphere.updateMatrixWorld(true)
const point = { id: 'curve-test', part: { partId: 'curve-test' } }
const record = {
  faultId: 'F-curve-test', pointId: point.id, faultType: 'crack',
  anchor: { position: [0, 0, 1], normal: [0, 0, 1], tangent: [1, 0, 0] },
  glyph: { size: 0.38 },
}
const marker = createFaultMarkerFromRecord(point, record)
const vertices = conformMarkerGeometry({
  marker,
  modelRoot: sphere,
  authoringBox: new THREE.Box3(new THREE.Vector3(-1.2, -1.2, -1.2), new THREE.Vector3(1.2, 1.2, 1.2)),
  baseNormal: new THREE.Vector3(0, 0, 1),
})
const radii = []
for (let i = 0; i < vertices.length; i += 3) radii.push(new THREE.Vector3(vertices[i], vertices[i + 1], vertices[i + 2]).length())
const maxError = Math.max(...radii.map((radius) => Math.abs(radius - 1.0025)))
check('故障图形全部顶点完成曲面投影', vertices.length === marker.line.geometry.getAttribute('position').count * 3)
check('故障图形没有遗留悬空顶点', marker.conformedVertices === marker.totalVertices, `${marker.conformedVertices}/${marker.totalVertices}`)
check('曲面贴合误差不超过4mm', maxError <= 0.004, `最大误差 ${(maxError * 1000).toFixed(2)}mm`)

console.log(`\n出题表面断言通过 ${passed} · 失败 ${failed}`)
if (failed) process.exit(1)
