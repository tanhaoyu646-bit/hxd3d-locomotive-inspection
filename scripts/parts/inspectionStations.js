import * as THREE from 'three'

const AXLE_TYPES = new Set(['wheelset', 'axlebox', 'primarySpring', 'brakeDisc', 'brakeUnit'])
const PILOT_TYPES = new Set(['pilot'])
const UNDERCAR_TYPES = new Set(['undercar'])
const STATION_SEQUENCE = [
  'station-pilot-front',
  'station-axle-1-right', 'station-axle-2-right', 'station-axle-3-right',
  'station-bogie-front-right', 'station-bogie-rear-right',
  'station-axle-4-right', 'station-axle-5-right', 'station-axle-6-right',
  'station-pilot-rear',
  'station-axle-6-left', 'station-axle-5-left', 'station-axle-4-left',
  'station-bogie-rear-left', 'station-undercar', 'station-bogie-front-left',
  'station-axle-3-left', 'station-axle-2-left', 'station-axle-1-left',
]
const STATION_ORDER = new Map(STATION_SEQUENCE.map((id, index) => [id, index + 1]))

function averageVector(points, getter) {
  const result = new THREE.Vector3()
  if (!points.length) return result
  points.forEach((point) => result.add(getter(point)))
  return result.multiplyScalar(1 / points.length)
}

function representative(parts, preferredTypes) {
  for (const type of preferredTypes) {
    const point = parts.find((candidate) => candidate.part?.type === type)
    if (point) return point
  }
  return parts[0]
}

function unionBox(parts, key) {
  const boxes = parts.map((point) => point[key]).filter(Boolean)
  if (!boxes.length) return null
  return boxes.slice(1).reduce((box, next) => box.union(next.clone()), boxes[0].clone())
}

function stationOutward(parts) {
  const lead = parts[0]?.part ?? {}
  if (lead.type === 'pilot') return new THREE.Vector3(lead.bogie === 'front' ? 1 : -1, 0, 0)
  if (lead.type === 'undercar') return new THREE.Vector3(0, 0, -1)
  return new THREE.Vector3(0, 0, lead.side === 'right' ? 1 : -1)
}

function makeStation({ id, label, shortName, parts, preferredTypes, modelBounds, focusParts = parts }) {
  const lead = representative(parts, preferredTypes)
  // 站位可以覆盖多个语义零部件，但初始镜头应聚焦在现场主要检查区，
  // 不能因为同站位还包含挡风玻璃等高位部件就把旋转中心抬高。
  const geometryBox = unionBox(focusParts.length ? focusParts : parts, 'geometryBox')
  const authoringBox = unionBox(parts, 'authoringBox') ?? geometryBox?.clone?.() ?? null
  const orbitTarget = geometryBox
    ? geometryBox.getCenter(new THREE.Vector3())
    : averageVector(parts, (point) => point.orbitTarget ?? point.position)
  const outward = stationOutward(parts)
  const half = geometryBox?.getSize(new THREE.Vector3()).multiplyScalar(0.5) ?? new THREE.Vector3(.5, .5, .5)
  const extent = Math.abs(outward.x) * half.x + Math.abs(outward.z) * half.z
  const standPosition = orbitTarget.clone().addScaledVector(outward, extent + (lead?.part?.type === 'undercar' ? 1.0 : 1.35))
  standPosition.y = (modelBounds?.min?.y ?? 0) + 0.08
  return {
    id,
    itemId: lead?.itemId,
    item: lead?.item,
    route: lead?.route,
    part: lead?.part,
    // 光点是“人应站的位置”，视线目标则是该站位覆盖零部件的几何中心。
    position: standPosition,
    standPosition,
    interactionTarget: orbitTarget.clone(),
    lookTarget: orbitTarget.clone(),
    orbitTarget,
    geometryBox,
    authoringBox,
    partType: lead?.partType,
    faults: [],
    markers: [],
    found: 0,
    isPartPoint: true,
    isStationPoint: true,
    stationParts: parts,
    stationLabel: label,
    stationShortName: shortName,
    stationOrder: STATION_ORDER.get(id) ?? 999,
    inspectDistance: Math.max(lead?.part?.view?.distance ?? lead?.part?.view?.dist ?? 1.1, 1.1),
    approachRadius: 1.2,
    facingThreshold: 0.32,
    requireCrouch: id === 'station-undercar',
  }
}

/**
 * 将细粒度语义零部件归并为现场作业使用的标准观测站位。
 * 站位只负责接近、进入和镜头中心；故障、答案和评分仍记录在具体零部件上。
 */
export function buildRunningGearStations(partPoints, modelBounds = null, regionPoints = []) {
  const groups = new Map()
  const add = (key, point) => {
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(point)
  }

  for (const point of partPoints) {
    const part = point.part ?? {}
    if (part.axleNo && AXLE_TYPES.has(part.type)) {
      add(`axle:${part.axleNo}:${part.side}`, point)
    } else if (PILOT_TYPES.has(part.type)) {
      add(`pilot:${part.bogie}`, point)
    } else if (UNDERCAR_TYPES.has(part.type)) {
      add('undercar', point)
    } else {
      add(`bogie:${part.bogie}:${part.side}`, point)
    }
  }

  // 端部不能只把排障器当成可出题对象。车钩、风管、塞门、电气插座、
  // 挡风玻璃等原有区域点按外部观察方向并入对应端部站位。
  // 这些点仍保留自己的 pointId/itemId/faults，故障和评分不会混为“排障器”。
  for (const point of regionPoints) {
    const exterior = point?.fault?.exterior
    if (exterior === 'i-end') add('pilot:front', point)
    else if (exterior === 'ii-end') add('pilot:rear', point)
  }

  const stations = []
  for (const [key, parts] of groups) {
    if (key.startsWith('axle:')) {
      const [, axle, side] = key.split(':')
      const sideLabel = side === 'left' ? '左侧' : '右侧'
      stations.push(makeStation({
        id: `station-axle-${axle}-${side}`,
        label: `${axle}轴${sideLabel}标准检查站位`,
        shortName: `${axle}轴${sideLabel}`,
        parts,
        preferredTypes: ['axlebox', 'primarySpring', 'wheelset', 'brakeDisc', 'brakeUnit'],
        modelBounds,
      }))
      continue
    }
    if (key.startsWith('bogie:')) {
      const [, bogie, side] = key.split(':')
      const endLabel = bogie === 'front' ? 'I端' : 'II端'
      const sideLabel = side === 'left' ? '左侧' : '右侧'
      stations.push(makeStation({
        id: `station-bogie-${bogie}-${side}`,
        label: `${endLabel}转向架${sideLabel}综合检查站位`,
        shortName: `${endLabel}转向架${sideLabel}`,
        parts,
        preferredTypes: ['frame', 'secondarySpring', 'damper', 'tractionRod', 'motorGearbox', 'pipeFastener', 'sandBox'],
        modelBounds,
      }))
      continue
    }
    if (key.startsWith('pilot:')) {
      const bogie = key.split(':')[1]
      const endLabel = bogie === 'front' ? 'I端' : 'II端'
      const focusParts = parts.filter((point) => point.part?.type === 'pilot' || point.route?.id === 'coupler')
      stations.push(makeStation({
        id: `station-pilot-${bogie}`,
        label: `${endLabel}端部综合检查站位`,
        shortName: `${endLabel}端部`,
        parts,
        preferredTypes: ['pilot'],
        focusParts,
        modelBounds,
      }))
      continue
    }
    stations.push(makeStation({
      id: 'station-undercar',
      label: '车下通道综合检查站位',
      shortName: '车下通道',
      parts,
      preferredTypes: ['undercar'],
      modelBounds,
    }))
  }

  return stations.sort((a, b) => a.stationOrder - b.stationOrder)
}

export function semanticPointsFor(point) {
  return point?.isStationPoint ? point.stationParts : (point ? [point] : [])
}

export function markersForPoint(point) {
  return semanticPointsFor(point).flatMap((candidate) => candidate.markers ?? [])
}

/**
 * 将一次可见表面点击解析到站位中的具体零部件。先要求命中包围范围，
 * 再按相对包围盒尺度归一化距离排序，避免大构架范围抢走弹簧/制动盘点击。
 */
export function resolveStationPart(point, surfacePoint, tolerance = 0.24) {
  if (!surfacePoint) return null
  const candidates = semanticPointsFor(point)
    .map((candidate) => {
      const box = candidate.authoringBox ?? candidate.geometryBox
      if (!box || box.distanceToPoint(surfacePoint) > tolerance) return null
      const center = box.getCenter(new THREE.Vector3())
      const size = box.getSize(new THREE.Vector3())
      const dx = (surfacePoint.x - center.x) / Math.max(size.x * 0.5, 0.16)
      const dy = (surfacePoint.y - center.y) / Math.max(size.y * 0.5, 0.16)
      const dz = (surfacePoint.z - center.z) / Math.max(size.z * 0.5, 0.16)
      const volumePenalty = Math.cbrt(Math.max(size.x * size.y * size.z, 0.001)) * 0.035
      return { candidate, score: dx * dx + dy * dy + dz * dz + volumePenalty }
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score)
  return candidates[0]?.candidate ?? null
}

/**
 * 从整车射线结果的最前可见表面层解析站位内的语义零部件。
 *
 * GLB 中一个视觉部件往往由多个相邻三角面组成，最前命中面可能恰好落在
 * 语义包围盒边缘。旧实现只拿 hits[0] 猜一次零部件，猜错或越界就整次失败。
 * 这里允许在同一可见表面厚度内检查多个命中面，但绝不穿过明显遮挡物。
 */
export function resolveStationSurfaceHit(point, hits, {
  boundsTolerance = 0.42,
  visibleLayerDepth = 0.085,
} = {}) {
  if (!Array.isArray(hits) || !hits.length) return null
  const parts = semanticPointsFor(point)
  if (!parts.length) return null
  const firstDistance = Number(hits[0]?.distance) || 0
  const matches = []

  for (const hit of hits) {
    if (!hit?.point) continue
    const depth = (Number(hit.distance) || 0) - firstDistance
    if (depth > visibleLayerDepth) break
    for (const candidate of parts) {
      const box = candidate.authoringBox ?? candidate.geometryBox
      if (!box) continue
      const boxDistance = box.distanceToPoint(hit.point)
      if (boxDistance > boundsTolerance) continue
      const center = box.getCenter(new THREE.Vector3())
      const size = box.getSize(new THREE.Vector3())
      const dx = (hit.point.x - center.x) / Math.max(size.x * 0.5, 0.18)
      const dy = (hit.point.y - center.y) / Math.max(size.y * 0.5, 0.18)
      const dz = (hit.point.z - center.z) / Math.max(size.z * 0.5, 0.18)
      // 先奖励真正落在范围内的面，再按归一化中心距离区分重叠范围。
      const score = boxDistance * 18 + dx * dx + dy * dy + dz * dz + depth * 8
      matches.push({ point: candidate, hit, score, boxDistance, depth })
    }
  }

  matches.sort((a, b) => a.score - b.score || a.hit.distance - b.hit.distance)
  return matches[0] ?? null
}
