import * as THREE from 'three'

// 出题选面不能复用碰撞体。碰撞体强调通行边界，出题范围强调把真实外形完整包住。
const PICK_PADDING = Object.freeze({
  wheelset: [0.24, 0.22, 0.30],
  axlebox: [0.28, 0.28, 0.30],
  primarySpring: [0.30, 0.42, 0.30],
  brakeUnit: [0.30, 0.30, 0.28],
  damper: [0.36, 0.34, 0.28],
  tractionRod: [0.34, 0.28, 0.28],
  pipeFastener: [0.30, 0.30, 0.28],
  sandBox: [0.34, 0.34, 0.30],
  motorGearbox: [0.34, 0.32, 0.30],
  frame: [0.28, 0.28, 0.24],
  pilot: [0.28, 0.28, 0.28],
  undercar: [0.30, 0.30, 0.30],
  default: [0.24, 0.24, 0.24],
})

export function createAuthoringBox(part) {
  if (!part?.centerWorld || !Array.isArray(part.proxySize)) return null
  const center = new THREE.Vector3(part.centerWorld.x, part.centerWorld.y, part.centerWorld.z)
  const size = new THREE.Vector3(...part.proxySize)
  const padding = new THREE.Vector3(...(PICK_PADDING[part.type] ?? PICK_PADDING.default))
  const half = size.multiplyScalar(0.5).add(padding)
  return new THREE.Box3(center.clone().sub(half), center.clone().add(half))
}

export function configureInspectOrbit(controls, distance) {
  const dist = Number(distance) || 1.1
  controls.enablePan = false
  controls.minDistance = Math.max(0.55, dist * 0.52)
  controls.maxDistance = Math.max(1.05, dist * 1.65)
  controls.minPolarAngle = Math.PI * 0.08
  controls.maxPolarAngle = Math.PI * 0.95
  controls.minAzimuthAngle = -Infinity
  controls.maxAzimuthAngle = Infinity
}

/**
 * 从整车射线结果中选择当前语义零部件的表面。
 * 候选面必须位于零部件专用出题范围内；若前方另有明显遮挡，则禁止穿透设置。
 */
export function selectAuthoringHit(hits, authoringBox, occlusionTolerance = 0.045, boundsTolerance = 0.08) {
  if (!Array.isArray(hits) || !hits.length || !authoringBox) return null
  const candidate = hits.find((hit) => hit?.point && authoringBox.distanceToPoint(hit.point) <= boundsTolerance)
  if (!candidate) return null
  const front = hits[0]
  if (front !== candidate && candidate.distance - front.distance > occlusionTolerance) return null
  return candidate
}

function worldNormal(hit, fallback) {
  const normal = hit?.face
    ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
    : fallback.clone().normalize()
  if (normal.dot(fallback) < 0) normal.negate()
  return normal
}

/**
 * 将故障图形的每一个顶点重新吸附到真实模型曲面。
 * 对轮缘、轴箱端盖、弹簧和管路等曲面，避免只贴中心而两端悬空/穿入。
 */
export function conformMarkerGeometry({
  marker,
  modelRoot,
  authoringBox,
  baseNormal,
  raycaster = new THREE.Raycaster(),
  castDistance = 0.16,
  surfaceOffset = 0.0025,
}) {
  const position = marker?.line?.geometry?.getAttribute?.('position')
  if (!position || !modelRoot || !authoringBox || !baseNormal) return []
  const n = baseNormal.clone().normalize()
  const candidate = new THREE.Vector3()
  const origin = new THREE.Vector3()
  const direction = new THREE.Vector3()
  const stored = []
  let projected = 0

  for (let i = 0; i < position.count; i += 1) {
    candidate.fromBufferAttribute(position, i)
    let best = null
    for (const sign of [1, -1]) {
      origin.copy(candidate).addScaledVector(n, castDistance * sign)
      direction.copy(n).multiplyScalar(-sign)
      raycaster.set(origin, direction)
      raycaster.far = castDistance * 2
      const hits = raycaster.intersectObject(modelRoot, true)
      const hit = hits
        .filter((entry) => authoringBox.containsPoint(entry.point))
        .sort((a, b) => a.point.distanceToSquared(candidate) - b.point.distanceToSquared(candidate))[0]
      if (!hit) continue
      const distance = hit.point.distanceTo(candidate)
      if (!best || distance < best.distance) best = { hit, distance }
    }

    if (best && best.distance <= castDistance) {
      const normal = worldNormal(best.hit, n)
      candidate.copy(best.hit.point).addScaledVector(normal, surfaceOffset)
      position.setXYZ(i, candidate.x, candidate.y, candidate.z)
      projected += 1
    }
    stored.push(candidate.x, candidate.y, candidate.z)
  }

  position.needsUpdate = true
  marker.line.geometry.computeBoundingBox?.()
  marker.line.geometry.computeBoundingSphere?.()
  marker.conformedVertices = projected
  marker.totalVertices = position.count
  if (stored.length >= 3) {
    const center = new THREE.Vector3()
    for (let i = 0; i < stored.length; i += 3) center.add(new THREE.Vector3(stored[i], stored[i + 1], stored[i + 2]))
    center.multiplyScalar(3 / stored.length)
    marker.proxy?.position?.copy?.(center)
    marker.surfacePoint?.copy?.(center)
  }
  return stored
}
