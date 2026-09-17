import * as THREE from 'three'
import fs from 'node:fs'
import path from 'node:path'
import { GLTFLoader } from '../lib/three/addons/loaders/GLTFLoader.js'
import { buildRunningGearParts } from '../scripts/parts/runningGearParts.js'
import { buildRunningGearStations, resolveStationPart, resolveStationSurfaceHit } from '../scripts/parts/inspectionStations.js'
import { createAuthoringBox } from '../scripts/authoringSurface.js'

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) { pass += 1; console.log(`✓ ${label}${detail ? ` · ${detail}` : ''}`) }
  else { fail += 1; console.error(`✗ ${label}${detail ? ` · ${detail}` : ''}`) }
}

const pointFor = (part) => {
  const center = new THREE.Vector3(part.centerWorld.x, part.centerWorld.y, part.centerWorld.z)
  const half = new THREE.Vector3(...part.proxySize).multiplyScalar(0.5).addScalar(0.24)
  return {
    id: part.partId,
    itemId: part.itemId,
    item: { id: part.itemId, name: part.shortName },
    route: { id: 'bogie', shortName: '走行部' },
    part,
    position: center.clone(),
    interactionTarget: center.clone(),
    orbitTarget: center.clone(),
    geometryBox: new THREE.Box3(center.clone().sub(half), center.clone().add(half)),
    authoringBox: createAuthoringBox(part) ?? new THREE.Box3(center.clone().sub(half), center.clone().add(half)),
    markers: [],
    isPartPoint: true,
  }
}

const points = buildRunningGearParts().map(pointFor)
const stations = buildRunningGearStations(points)
const axleStations = stations.filter((station) => station.id.startsWith('station-axle-'))
const bogieStations = stations.filter((station) => station.id.startsWith('station-bogie-'))
const pilotStations = stations.filter((station) => station.id.startsWith('station-pilot-'))
const undercarStations = stations.filter((station) => station.id === 'station-undercar')

check('标准站位总数为 19', stations.length === 19, `实际 ${stations.length}`)
check('六轴左右共 12 个轴位站', axleStations.length === 12, `实际 ${axleStations.length}`)
check('前后转向架左右共 4 个综合站', bogieStations.length === 4, `实际 ${bogieStations.length}`)
check('两端排障器共 2 个站位', pilotStations.length === 2, `实际 ${pilotStations.length}`)
check('车下通道 1 个站位', undercarStations.length === 1, `实际 ${undercarStations.length}`)

const requiredAxleTypes = ['wheelset', 'axlebox', 'primarySpring', 'brakeDisc', 'brakeUnit']
for (const station of axleStations) {
  const types = new Set(station.stationParts.map((point) => point.part.type))
  check(`${station.stationShortName}覆盖五类轴位部件`, requiredAxleTypes.every((type) => types.has(type)))
  for (const point of station.stationParts) {
    const resolved = resolveStationPart(station, point.part.centerWorld, 0.30)
    check(`${station.stationShortName}可解析${point.part.shortName}`, resolved?.id === point.id,
      resolved?.id ? `解析为 ${resolved.id}` : '未解析')
  }
}

const sampleStation = axleStations[0]
const samplePart = sampleStation.stationParts.find((point) => point.part.type === 'primarySpring')
const sampleSurface = samplePart.authoringBox.getCenter(new THREE.Vector3())
const visibleHit = { point: sampleSurface, distance: 2, object: {} }
const resolvedSurface = resolveStationSurfaceHit(sampleStation, [visibleHit])
check('最前可见表面可解析到具体语义零部件', resolvedSurface?.point?.id === samplePart.id)
const blockedSurface = resolveStationSurfaceHit(sampleStation, [
  { point: new THREE.Vector3(999, 999, 999), distance: 1, object: {} },
  { point: sampleSurface, distance: 1.3, object: {} },
])
check('明显遮挡后的内部表面不能穿透出题', blockedSurface === null)

// 使用实际 GLB 三角面验证：每种轴位部件至少存在一个旋转视角，能够被当前站位
// 正确解析成自身，而不是被相邻轮对、轴箱或构架抢占。
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
const directions = []
for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) {
  if (x || y || z) directions.push(new THREE.Vector3(x, y, z).normalize())
}
for (const station of axleStations) {
  for (const type of requiredAxleTypes) {
    const point = station.stationParts.find((candidate) => candidate.part.type === type)
    const center = new THREE.Vector3(point.part.centerWorld.x, point.part.centerWorld.y, point.part.centerWorld.z)
    let resolved = null
    for (const outward of directions) {
      raycaster.set(center.clone().addScaledVector(outward, 4), outward.clone().negate())
      raycaster.far = 8
      const hits = raycaster.intersectObject(root, true)
      const candidate = resolveStationSurfaceHit(station, hits)
      if (candidate?.point?.id === point.id) { resolved = candidate; break }
    }
    check(`真实模型中${point.part.shortName}可从旋转视角独立出题`, Boolean(resolved))
  }
}

console.log(`\n标准站位断言通过 ${pass} · 失败 ${fail}`)
if (fail) process.exit(1)
