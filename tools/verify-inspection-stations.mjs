import * as THREE from 'three'
import { buildRunningGearParts } from '../scripts/parts/runningGearParts.js'
import { buildRunningGearStations, resolveStationPart } from '../scripts/parts/inspectionStations.js'

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
    authoringBox: new THREE.Box3(center.clone().sub(half), center.clone().add(half)),
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

console.log(`\n标准站位断言通过 ${pass} · 失败 ${fail}`)
if (fail) process.exit(1)
