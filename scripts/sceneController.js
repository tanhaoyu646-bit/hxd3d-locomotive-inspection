/**
 * 三维场景控制器 V3 —— 漫游 + 检查点聚焦检视
 * ---------------------------------------------------------------------------
 * 原则：原孪生平台模型只读、不改、不裁剪。
 *      所有检查内容以"检查点 + 故障标记"的形式叠加在模型之上。
 *
 * 三种模式：
 *   scene   场景模式：OrbitControls 观察整车（V1 行为）
 *   roam    漫游模式：人视角走动检查（碰撞 + 跳跃 + 下蹲 + 靠近交互）
 *   inspect 检视模式：相机聚焦放大到某个检查点，可旋转视角寻找故障标记
 *
 * 交互链：
 *   漫游靠近检查点 → 提示 → E/虚拟交互键 → 聚焦放大（进入 inspect）
 *   → 旋转视角找到标记 → 点击标记 → 填报故障活件 → 符号语义核验计分
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DualPlayerController } from './player/DualPlayerController.js'
import { createLocomotiveCollisionSystem } from './parts/LocomotiveCollisionSystem.js'
import { getRunningGearParts, getRunningGearItemIds } from './parts/runningGearParts.js'
import { createPartInteractionFSM } from './parts/partInteractionFSM.js'
import { buildItemIndex } from './inspectionData.js'
import {
  buildInspectionPoints,
  buildPartPoints,
  paintFaultMarkersOnModel,
  paintFaultMarkersOnPart,
  createPointMarker,
  regionCenter,
  FAULT_KEYWORDS,
} from './partInspection.js'

const LOCAL_MODEL = 'models/hxd3d-integration-spatial.glb'
const LOCAL_RAIL = 'models/rail-segment.glb'
const SHARED_MODEL =
  '../机车数字孪生/01-系统程序（V1至V2.3）/hxd3d-digital-twin/public/models/hxd3d/hxd3d-integration-spatial.glb'
const SHARED_RAIL =
  '../机车数字孪生/01-系统程序（V1至V2.3）/hxd3d-digital-twin/public/models/hxd3d/rail-segment.glb'

const HIGHLIGHT_COLOR = 0x38a8ff
const NEAR_DISTANCE = 4.5      // 触发"可交互"的距离（区域检查点沿用）
const INSPECT_DISTANCE = 1.1   // 聚焦放大后的观察距离

/** 走行部检查项：这些检查项改由零部件配置驱动，不再用手写的 fault.region */
const RUNNING_GEAR_ITEM_IDS = new Set(getRunningGearItemIds())

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

async function pickModelUrl(candidates) {
  for (const url of candidates) {
    try {
      const r = await fetch(url, { method: 'HEAD' })
      if (r.ok) return url
    } catch { /* 继续尝试 */ }
  }
  return candidates[candidates.length - 1]
}

export function createInspectionScene(container, callbacks = {}) {
  if (!container) return { destroy: () => {}, focusRoute: () => {} }

  // ── 渲染器与场景（沿用原平台参数） ──
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x06111d)
  scene.fog = new THREE.Fog(0x06111d, 42, 112)

  const camera = new THREE.PerspectiveCamera(52, 1, 0.05, 200)
  camera.position.set(14, 6, 16)

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.92
  renderer.domElement.tabIndex = 0
  container.appendChild(renderer.domElement)

  const orbitControls = new OrbitControls(camera, renderer.domElement)
  orbitControls.enableDamping = true
  orbitControls.dampingFactor = 0.065
  orbitControls.enablePan = true
  orbitControls.minDistance = 0.6
  orbitControls.maxDistance = 58
  orbitControls.maxPolarAngle = Math.PI * 0.92
  orbitControls.target.set(0, 2.2, 0)

  // ── 灯光 ──
  scene.add(new THREE.HemisphereLight(0xbde8f3, 0x1e2a35, 0.96))
  const keyLight = new THREE.DirectionalLight(0xfff2dc, 1.5)
  keyLight.position.set(13, 19, 11)
  scene.add(keyLight)
  const fillLight = new THREE.DirectionalLight(0x80bfe0, 0.9)
  fillLight.position.set(-13, 8, -14)
  scene.add(fillLight)
  const rimLight = new THREE.DirectionalLight(0x3ba9d8, 0.52)
  rimLight.position.set(3, 5, 16)
  scene.add(rimLight)

  // ── 地面与网格 ──
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(180, 180),
    new THREE.MeshStandardMaterial({ color: 0x172633, metalness: 0.05, roughness: 0.9 }),
  )
  ground.rotation.x = -Math.PI / 2
  ground.position.y = -0.462
  scene.add(ground)
  const grid = new THREE.GridHelper(180, 180, 0x1f7894, 0x193e50)
  grid.position.y = -0.451
  grid.material.transparent = true
  grid.material.opacity = 0.28
  scene.add(grid)

  // ── 高亮图层（场景模式部位定位） ──
  const highlightGroup = new THREE.Group()
  scene.add(highlightGroup)
  const glowMaterial = new THREE.MeshBasicMaterial({ color: HIGHLIGHT_COLOR, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide })
  const glowBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glowMaterial)
  glowBox.visible = false
  highlightGroup.add(glowBox)
  const edgeMaterial = new THREE.LineBasicMaterial({ color: HIGHLIGHT_COLOR, transparent: true, opacity: 0.95 })
  const edgeLines = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), edgeMaterial)
  edgeLines.visible = false
  highlightGroup.add(edgeLines)

  // ── 检查点图层 ──
  const pointGroup = new THREE.Group()
  pointGroup.name = 'InspectionPoints'
  scene.add(pointGroup)
  /** 故障标记图层（直接叠加在原模型表面） */
  const markerGroup = new THREE.Group()
  markerGroup.name = 'FaultMarkers'
  scene.add(markerGroup)

  // ── 状态 ──
  let destroyed = false
  let frameId = 0
  let locomotiveRoot = null
  let modelBounds = null
  let cameraTween = null
  let pulse = 0
  let activeRouteId = null
  let lastCenter = null
  let mode = 'scene'
  let playerController = null
  let collisionResolver = null
  let inspectionPoints = []
  let partPoints = []           // 走行部零部件检查点
  let routeEntryPoints = []     // 环节入口点（如「升弓电气检查」车外点）：站上去按交互键进入该环节
  let partFSM = null            // 接近—观察—确认状态机
  let activePoint = null        // 当前聚焦的检查点
  let nearestPoint = null       // 漫游时最近的检查点
  let runningGearRoute = null   // 走行部路由（零部件检查点归属）
  let nearKey = null            // 当前 near-hint 关键字，避免每帧重复回调 UI
  const clock = new THREE.Clock()
  const gltfLoader = new GLTFLoader()
  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  const emissiveBackup = new Map()

  const resize = () => {
    const w = Math.max(container.clientWidth, 1)
    const h = Math.max(container.clientHeight, 1)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h, false)
  }
  const ro = new ResizeObserver(resize)
  ro.observe(container)
  resize()

  // ── 部位定位（沿用 V1） ──
  function regionToBox(region) {
    if (!modelBounds) return null
    const s = modelBounds.getSize(new THREE.Vector3())
    return new THREE.Box3(
      new THREE.Vector3(modelBounds.min.x + s.x * region.u[0], modelBounds.min.y + s.y * region.v[0], modelBounds.min.z + s.z * region.w[0]),
      new THREE.Vector3(modelBounds.min.x + s.x * region.u[1], modelBounds.min.y + s.y * region.v[1], modelBounds.min.z + s.z * region.w[1]),
    )
  }
  function nodeBoxes(names) {
    if (!locomotiveRoot || !names?.length) return []
    const out = []
    for (const n of names) {
      const o = locomotiveRoot.getObjectByName(n)
      if (!o) continue
      const b = new THREE.Box3().setFromObject(o)
      if (!b.isEmpty()) out.push({ name: n, object: o, box: b })
    }
    return out
  }
  function resolveRouteTarget(route) {
    const focus = route?.focus ?? {}
    const boxes = []
    const nodeObjects = []
    if (focus.type === 'node') {
      for (const e of nodeBoxes(focus.nodes ?? [])) { boxes.push(e.box); nodeObjects.push(e.object) }
    }
    for (const rg of focus.regions ?? []) {
      const b = regionToBox(rg)
      if (b) boxes.push(b)
    }
    if (!boxes.length) boxes.push(modelBounds ? modelBounds.clone() : new THREE.Box3(new THREE.Vector3(-11, 0, -1.8), new THREE.Vector3(11, 6.4, 1.8)))
    const union = boxes.reduce((a, b) => a.union(b.clone()), boxes[0].clone())
    return { boxes, center: union.getCenter(new THREE.Vector3()), union, nodeObjects }
  }

  // ── 高亮 ──
  function clearNodeHighlight() {
    emissiveBackup.forEach((b, m) => {
      if (!m) return
      if (b.emissive === null) m.emissive?.setHex(0x000000)
      else if (m.emissive) { m.emissive.setHex(b.emissive); m.emissiveIntensity = b.emissiveIntensity }
    })
    emissiveBackup.clear()
  }
  function applyNodeHighlight(objs) {
    for (const o of objs) {
      o.traverse?.((c) => {
        if (!c.isMesh) return
        const mats = Array.isArray(c.material) ? c.material : [c.material]
        mats.filter(Boolean).forEach((m) => {
          if (!m.emissive || emissiveBackup.has(m)) return
          emissiveBackup.set(m, { emissive: m.emissive ? m.emissive.getHex() : null, emissiveIntensity: m.emissiveIntensity ?? 1 })
          m.emissive.setHex(HIGHLIGHT_COLOR)
          m.emissiveIntensity = 0.85
        })
      })
    }
  }
  function showBoxHighlight(box) {
    const s = box.getSize(new THREE.Vector3())
    const c = box.getCenter(new THREE.Vector3())
    const padded = s.clone().addScalar((s.length() * 0.02 + 0.04) * 2)
    glowBox.scale.set(padded.x, padded.y, padded.z); glowBox.position.copy(c); glowBox.visible = true
    edgeLines.scale.set(padded.x, padded.y, padded.z); edgeLines.position.copy(c); edgeLines.visible = true
  }
  function hideHighlight() { glowBox.visible = false; edgeLines.visible = false; clearNodeHighlight() }

  // ── 相机调度 ──
  function startCameraMove(pose, { duration = 900, instant = false, onDone } = {}) {
    if (instant) {
      camera.position.copy(pose.position)
      orbitControls.target.copy(pose.target)
      camera.lookAt(pose.target)
      orbitControls.update()
      onDone?.()
      return
    }
    cameraTween = {
      startedAt: performance.now(), duration,
      fromPosition: camera.position.clone(), toPosition: pose.position.clone(),
      fromTarget: orbitControls.target.clone(), toTarget: pose.target.clone(), onDone,
    }
  }
  function updateCameraTween(now) {
    if (!cameraTween) return
    const raw = Math.min(1, (now - cameraTween.startedAt) / cameraTween.duration)
    const t = easeInOutCubic(raw)
    camera.position.lerpVectors(cameraTween.fromPosition, cameraTween.toPosition, t)
    orbitControls.target.lerpVectors(cameraTween.fromTarget, cameraTween.toTarget, t)
    camera.lookAt(orbitControls.target)
    if (raw < 1) return
    const { onDone } = cameraTween
    cameraTween = null
    onDone?.()
  }

  function focusRoute(route, options = {}) {
    if (!route) return
    activeRouteId = route.id
    const target = resolveRouteTarget(route)
    hideHighlight()
    if (!String(route.id).startsWith('__view_')) lastCenter = target.center.clone()
    if (route.focus?.type === 'none') {
      const c = modelBounds ? modelBounds.getCenter(new THREE.Vector3()) : new THREE.Vector3(0, 2.2, 0)
      startCameraMove(computePose(route, { center: c }), { duration: 860 })
      return
    }
    showBoxHighlight(target.union)
    applyNodeHighlight(target.nodeObjects)
    startCameraMove(computePose(route, target), { duration: options.duration ?? 1040, instant: options.instant })
  }

  function computePose(route, target) {
    const size = modelBounds ? modelBounds.getSize(new THREE.Vector3()) : new THREE.Vector3(3.6, 6.4, 23)
    const dir = new THREE.Vector3(...(route?.focus?.camera?.dir ?? [0.6, 0.45, 1])).normalize()
    const distance = Math.max(6, size.z * (route?.focus?.camera?.distance ?? 0.5))
    const position = target.center.clone().addScaledVector(dir, distance)
    position.y = Math.max(position.y, target.center.y - size.y * 0.1)
    return { position, target: target.center.clone() }
  }

  function resetView() {
    activeRouteId = null
    lastCenter = null
    hideHighlight()
    setMode('scene')
    const c = modelBounds ? modelBounds.getCenter(new THREE.Vector3()) : new THREE.Vector3(0, 2.2, 0)
    const s = modelBounds ? modelBounds.getSize(new THREE.Vector3()) : new THREE.Vector3(3.6, 6.4, 23)
    const target = c.clone()
    target.y = modelBounds ? modelBounds.min.y + s.y * 0.42 : 2.4
    startCameraMove({
      position: new THREE.Vector3(Math.max(12, s.x * 3.3), target.y + 3.6, Math.max(18, s.z * 0.9) * 0.72),
      target,
    }, { duration: 900 })
  }

  // ── 检查点 ──
  function buildPoints(routes) {
    // 清理旧的
    while (pointGroup.children.length) {
      const c = pointGroup.children.pop()
      c.traverse?.((o) => { o.geometry?.dispose?.(); o.material?.dispose?.() })
    }
    while (markerGroup.children.length) {
      const c = markerGroup.children.pop()
      c.geometry?.dispose?.(); c.material?.dispose?.()
    }
    // 走行部检查项改由零部件配置驱动（实测几何，不再用手工区域）
    runningGearRoute = routes.find((r) => r.id === 'bogie') ?? null
    const regionPoints = buildInspectionPoints(routes, modelBounds, {
      excludeItems: RUNNING_GEAR_ITEM_IDS,
    })
    partPoints = runningGearRoute
      ? buildPartPoints(getRunningGearParts(), runningGearRoute, buildItemIndex())
      : []
    partPoints.forEach(calibratePartAnchor)
    inspectionPoints = [...regionPoints, ...partPoints]

    // ── 环节入口点：升弓电气检查（车外安全确认）──
    // 车顶高压设备在出勤整备中无法登顶检视（需停电验电挂地线），原 roof 环节
    // 5 个子项均无三维点位、不可走到交互。这里在「机车外方（车侧平台位）」放一个
    // 地面交互点：站上去、面向车体（车顶方向）、按 E / 手机交互键即可确认。
    routeEntryPoints = []
    const roofRoute = routes.find((r) => r.id === 'roof') ?? null
    if (roofRoute && modelBounds) {
      const c = modelBounds.getCenter(new THREE.Vector3())
      const s = modelBounds.getSize(new THREE.Vector3())
      const pos = new THREE.Vector3(
        c.x,                          // 车身中段（沿车长方向）
        modelBounds.min.y + 0.12,    // 贴近地面
        modelBounds.min.z - 2.2,     // 车体外侧（左/平台侧）2.2m，确保站在车外
      )
      const entry = {
        id: 'roof-entry',
        routeId: 'roof',
        route: roofRoute,
        item: { id: 'roof-entry', name: '升弓电气检查（车外）', shortName: '升弓电气检查' },
        position: pos,
        region: null,
        partType: 'electrical',
        faults: [],
        markers: [],
        markerGroup: null,
        found: 0,
        isPartPoint: false,
        isRouteEntry: true,
      }
      routeEntryPoints.push(entry)
      inspectionPoints.push(entry)
      const marker = createPointMarker(entry, inspectionPoints.length - 1)
      entry.node = marker
    }

    inspectionPoints.forEach((p, i) => {
      const marker = createPointMarker(p, i)
      pointGroup.add(marker)
      p.node = marker
    })
    return inspectionPoints
  }

  /**
   * 将配置中的语义中心校准到原模型真实表面，并保存严格的部件限定盒。
   * 原 GLB 是合并网格，无法依赖 mesh 名称；因此显示模型保持不变，交互使用独立语义代理。
   */
  function calibratePartAnchor(point) {
    if (!locomotiveRoot || !point?.part) return
    const part = point.part
    const center = point.position.clone()
    const [sx, sy, sz] = part.proxySize
    const box = new THREE.Box3(
      center.clone().add(new THREE.Vector3(-sx / 2, -sy / 2, -sz / 2)),
      center.clone().add(new THREE.Vector3(sx / 2, sy / 2, sz / 2)),
    ).expandByScalar(0.16)
    point.geometryBox = box

    const outboard = new THREE.Vector3(0, 0, -1)
    if (part.side === 'right') outboard.set(0, 0, 1)
    else if (part.type === 'undercar') outboard.set(0, -1, 0)
    else if (part.type === 'pilot') outboard.set(part.bogie === 'front' ? 1 : -1, 0, 0)
    const origin = center.clone().addScaledVector(outboard, 3.5)
    raycaster.set(origin, outboard.clone().negate())
    raycaster.far = 7
    const hit = raycaster.intersectObject(locomotiveRoot, true).find((h) => box.containsPoint(h.point))
    point.surfaceAnchor = hit?.point?.clone?.() ?? null
    point.interactionTarget = point.surfaceAnchor?.clone?.() ?? center.clone()
  }

  /** 零部件检查点是否被车体/其他部件遮挡（从眼睛到部件中心） */
  function isPartOccluded(part, eye) {
    if (!locomotiveRoot) return false
    const calibrated = partPoints.find((p) => p.part?.partId === part.partId)
    const target = calibrated?.interactionTarget?.clone?.()
      ?? new THREE.Vector3(part.centerWorld.x, part.centerWorld.y, part.centerWorld.z)
    const dir = target.clone().sub(eye)
    const dist = dir.length()
    if (dist < 0.5) return false
    dir.normalize()
    raycaster.set(eye, dir)
    // 留 0.22m 余量，避免贴到部件自身表面时误判为遮挡
    raycaster.far = Math.max(0.05, dist - 0.12)
    return raycaster.intersectObject(locomotiveRoot, true).length > 0
  }

  /** 玩家姿态上下文（供交互状态机使用） */
  function getPlayerContext() {
    if (!playerController) return null
    const p = playerController.player
    const crouching = p.eyeHeight < (p.standingEyeHeight + p.crouchEyeHeight) / 2
    const f = getPlayerForward()
    return {
      position: p.position,
      eyeHeight: p.eyeHeight,
      crouching,
      forward: f,
    }
  }

  /** 为检查点生成故障标记（零部件检查点锚定到该零部件表面，区域点沿用原逻辑） */
  function activatePointFaults(point) {
    if (!point || point.markers.length) return point?.markers ?? []
    // 同一检查点在一次训练及重检时使用相同布置，保证评分可复盘。
    let hash = 2166136261
    for (const ch of String(point.id)) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619)
    const seed = (hash >>> 0) / 4294967296
    const markers = point.isPartPoint
      ? paintFaultMarkersOnPart(locomotiveRoot, point, { seed })
      : paintFaultMarkersOnModel(locomotiveRoot, point, { seed })
    markers.forEach((m) => {
      markerGroup.add(m.line)
      markerGroup.add(m.proxy)
    })
    point.markers = markers
    return markers
  }

  /** 玩家水平朝向（基于相机 forward，漫游模式下由 playerController 同步） */
  function getPlayerForward() {
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
    f.y = 0
    if (f.lengthSq() < 1e-8) f.set(0, 0, -1)
    return f.normalize()
  }

  function getCameraForward3D() {
    return new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize()
  }

  /**
   * HUD 与按键共用同一个目标解析器：按准星指向优先，再按距离排序。
   * 这样端部同一 x/z 上的车钩、风管、玻璃和灯具不会再按数组顺序互相抢占。
   */
  function resolveInteractionTarget(ctx, { hud = false } = {}) {
    const eye = ctx.position.clone().add(new THREE.Vector3(0, ctx.eyeHeight ?? 1.7, 0))
    const forward = getCameraForward3D()
    const minAim = hud ? 0.56 : 0.64
    let best = null
    for (const point of inspectionPoints) {
      const target = point.interactionTarget ?? point.position
      const dx = target.x - ctx.position.x
      const dz = target.z - ctx.position.z
      const horizontalDistance = Math.hypot(dx, dz)
      const maxDistance = point.isPartPoint
        ? (point.part.approach?.maxDistance ?? 3) + (hud ? 2.0 : 0.65)
        : NEAR_DISTANCE + (hud ? 0.8 : 0)
      if (horizontalDistance > maxDistance) continue
      const toTarget = target.clone().sub(eye)
      const spatialDistance = toTarget.length()
      if (spatialDistance < 0.05) continue
      const aim = forward.dot(toTarget.multiplyScalar(1 / spatialDistance))
      if (aim < minAim) continue
      // 准星方向远比距离重要；距离只在近似同向的候选之间消歧。
      const score = aim * 10 - horizontalDistance * 0.12 - spatialDistance * 0.015
      if (!best || score > best.score) {
        best = { point, distance: horizontalDistance, spatialDistance, aim, score }
      }
    }
    return best
  }

  /** 检查点是否被车体遮挡（从玩家眼睛到检查点发线，命中车体即遮挡） */
  function isPointOccluded(point, playerPos) {
    if (!locomotiveRoot) return false
    const origin = playerPos.clone()
    origin.y += playerController ? playerController.player.eyeHeight : 1.7
    const dir = point.position.clone().sub(origin)
    const dist = dir.length()
    if (dist < 0.5) return false
    dir.normalize()
    raycaster.set(origin, dir)
    raycaster.far = dist - 0.35 // 到检查点前留余量
    const hits = raycaster.intersectObject(locomotiveRoot, true)
    return hits.length > 0
  }

  /**
   * 最近检查点判定 —— 距离 + 朝向 + 遮挡（skill 约束 2）
   * @param {THREE.Vector3} position 玩家位置
   * @param {Object} opts { checkFacing, checkOcclusion }
   */
  function getNearestPoint(position, opts = {}) {
    const { checkFacing = false, checkOcclusion = false } = opts
    const forward = checkFacing ? getPlayerForward() : null
    let best = null
    let bestD = Infinity
    let bestFacing = 0
    for (const p of inspectionPoints) {
      // ★ 水平距离（xz）而非 3D 距离：玩家站在地面也能触发车顶检查点
      const dx = p.position.x - position.x
      const dz = p.position.z - position.z
      const d = Math.hypot(dx, dz)
      if (d >= bestD) continue
      // 朝向：玩家须面向检查点（点积 > 0.35，约 ±70° 视野内）
      if (checkFacing) {
        let facing
        if (d < 0.5) {
          facing = 1 // 几乎在正下方/正上方，视为已面向
        } else {
          facing = forward.x * (dx / d) + forward.z * (dz / d)
          if (facing < 0.35) continue
        }
        bestFacing = facing
      }
      bestD = d
      best = p
    }
    const occluded = best && checkOcclusion ? isPointOccluded(best, position) : false
    return { point: best, distance: bestD, facing: bestFacing, occluded }
  }

  /**
   * 漫游靠近检测：综合「走行部零部件（FSM 8 步）」与「区域检查点（旧机制）」，
   * 产出统一的 near 描述，供 UI 显示「部件名称 + 距离 + 交互条件」
   * @param {Object} ctx 玩家姿态上下文（getPlayerContext）
   * @returns {Object|null}
   */
  function computeNearDescriptor(ctx) {
    const selected = resolveInteractionTarget(ctx, { hud: true })
    if (!selected) return null
    const p = selected.point
    if (p.isPartPoint) {
      // 每帧 HUD 不做昂贵遮挡射线；真正按键时再完整校验。
      const ev = partFSM.evaluate(p, ctx, { skipOcclusion: true })
      const unmet = ev.unmet[0]
      return {
        kind: 'part',
        point: p,
        partId: p.part.partId,
        name: p.part.name,
        shortName: p.part.shortName,
        itemId: p.part.itemId,
        distance: selected.distance,
        stage: ev.stage,
        stageLabel: ev.stageMeta.label,
        stageHint: ev.stageMeta.hint,
        conditions: ev.conditions,
        canEnter: ev.canEnter,
        unmetLabel: unmet ? unmet.label : null,
      }
    }
    if (p.isRouteEntry) {
      const unlocked = callbacks.isRouteUnlocked ? callbacks.isRouteUnlocked(p.routeId) : true
      const canEnter = unlocked
      const unmetLabel = unlocked ? '' : '该环节尚未解锁'
      return {
        kind: 'region', point: p, distance: selected.distance, routeEntry: true,
        canEnter, name: p.item.shortName, shortName: p.item.shortName, unmetLabel,
      }
    }
    return { kind: 'region', point: p, distance: selected.distance, canEnter: true, name: p.item.name, shortName: p.item.name }
  }

  /** 聚焦放大到检查点（"零部件放大并可旋转"） */
  function focusOnPoint(point, { instant = false } = {}) {
    if (!point) return false
    activePoint = point
    // 升弓电气检查（车外点）：相机站在车外、略高，仰望车顶高压设备
    if (point.isRouteEntry && modelBounds) {
      const center = modelBounds.getCenter(new THREE.Vector3())
      const size = modelBounds.getSize(new THREE.Vector3())
      const roofY = modelBounds.min.y + size.y * 0.92
      const target = new THREE.Vector3(point.position.x, roofY, center.z)
      const position = point.position.clone().add(new THREE.Vector3(0, 1.7, -1.6))
      startCameraMove({ position, target }, { duration: instant ? 0 : 820, instant })
      return true
    }
    activatePointFaults(point)
    // 相机靠近该点，OrbitControls 围绕它旋转 = 放大检视
    let offsetDir
    let dist = INSPECT_DISTANCE
    if (point.isPartPoint && point.part?.view) {
      // 每个部件自己的推荐检查镜头：从部件外侧（学生站位侧）看向部件
      const outboard = new THREE.Vector3()
      const side = point.part.side
      if (side === 'left') outboard.set(0, 0, -1)
      else if (side === 'right') outboard.set(0, 0, 1)
      else if (point.part.type === 'undercar') outboard.set(0, -1, 0)
      else if (point.part.type === 'pilot') outboard.set(point.part.bogie === 'front' ? 1 : -1, 0, 0)
      else outboard.set(0, 0, -1)
      const pitch = point.part.view.pitch ?? 0
      dist = point.part.view.distance ?? INSPECT_DISTANCE
      offsetDir = outboard.clone()
      offsetDir.y += pitch * 1.4 + 0.35 // 俯仰转化为相机高度偏移
      offsetDir.normalize()
    } else {
      offsetDir = new THREE.Vector3(0.8, 0.35, 1).normalize()
    }
    const target = point.interactionTarget?.clone?.() ?? point.position.clone()
    const position = target.clone().addScaledVector(offsetDir, dist)
    startCameraMove({ position, target }, { duration: instant ? 0 : 820, instant })
    return true
  }

  // ── 模式 ──
  function setMode(newMode) {
    if (newMode === mode) return
    if (mode === 'roam') {
      playerController?.disable()
      orbitControls.enabled = true
    }
    if (mode === 'inspect') {
      activePoint = null
      callbacks.onInspectExit?.()
    }
    mode = newMode
    // 漫游/检视：隐藏场景模式的大面积半透明高亮盒（降透明混合开销，避免挡视线）
    if (mode !== 'scene') hideHighlight()
    if (mode === 'roam') {
      orbitControls.enabled = false
      playerController?.enable()
      pointGroup.visible = true
      // ★ 关键：把相机从「俯瞰全车的场景视角」重置为「人眼水平看向车体」
      if (playerController && modelBounds) {
        const euler = resetRoamingView()
        if (euler) {
          playerController.yaw = euler.yaw
          playerController.pitch = euler.pitch
        }
      }
    } else {
      orbitControls.enabled = true
      // 检视模式：隐藏检查点光圈，避免遮挡部件表面细小的故障标记（裂纹/烧损）
      // 光圈只在漫游模式显示（用于引导玩家寻找检查部位）
      pointGroup.visible = false
    }
    callbacks.onModeChange?.(mode)
  }

  /**
   * 进入漫游模式时，把相机从玩家位置水平看向模型，并同步移动端 yaw/pitch。
   * 解决"切换到漫游后画面变黑/看到天空"的问题——相机继承了场景模式俯瞰姿态。
   */
  function resetRoamingView() {
    if (!playerController || !modelBounds) return null
    const playerPos = playerController.player.position
    const center = modelBounds.getCenter(new THREE.Vector3())
    const lookY = Math.max(center.y * 0.5, playerPos.y + 1.6)
    const target = new THREE.Vector3(center.x, lookY, center.z)
    // ★ 先把相机同步到玩家位置（playerController.spawnFromBounds 设置后，
    //   startCameraMove(instant) 把相机改回场景视角位置 —— 必须显式还原）
    camera.position.set(
      playerPos.x,
      playerPos.y + playerController.player.eyeHeight,
      playerPos.z,
    )
    camera.lookAt(target)
    camera.updateMatrixWorld(true)
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ')
    return { yaw: e.y, pitch: e.x }
  }

  /** 漫游中按 E / 手机「交互」键：走行部零部件必须用 FSM 8 步门槛；区域点沿用旧机制 */
  function handleInteract() {
    if (mode !== 'roam' || !modelBounds || !playerController) return
    const ctx = getPlayerContext()
    const selected = resolveInteractionTarget(ctx)
    if (!selected) {
      callbacks.onToast?.('请靠近并将准星对准要检查的部件')
      return
    }
    const p = selected.point
    if (p.isRouteEntry) {
      if (!callbacks.isRouteUnlocked?.(p.routeId)) {
        callbacks.onToast?.('该环节尚未解锁')
        return
      }
      setMode('inspect')
      focusOnPoint(p)
      callbacks.onInspectEnter?.(p)
      return
    }
    if (p.isPartPoint) {
      const ev = partFSM.evaluate(p, ctx)
      if (ev.canEnter) {
        partFSM.beginInspect(p.part)
        setMode('inspect')
        focusOnPoint(p)
        callbacks.onInspectEnter?.(p)
        return
      }
      const unmet = ev.unmet[0]
      callbacks.onToast?.(unmet?.detail || ev.stageMeta.hint || '请满足检查条件后再交互')
      return
    }
    setMode('inspect')
    focusOnPoint(p)
    callbacks.onInspectEnter?.(p)
  }

  /** 场景中直接检视某检查项（从右侧面板按钮触发） */
  function inspectItem(item, route) {
    const point = inspectionPoints.find((p) => p.id === item?.id)
    if (!point) {
      callbacks.onToast?.('该检查项没有可检视的三维点位')
      return false
    }
    if (point.isPartPoint) {
      // 走行部零部件：右侧卡片只做「定位 / 提示」，不直接进入检视。
      // 学生须走到该部件允许的检查站位、面向它、满足朝向 / 遮挡后按 E / 交互键。
      const part = point.part
      callbacks.onToast?.(`「${part.name}」请走到车外对应站位，面向部件后按 E / 交互键检视`)
      return false
    }
    setMode('inspect')
    focusOnPoint(point)
    callbacks.onInspectEnter?.(point)
    return true
  }

  // ── 拾取：点击故障标记 ──
  renderer.domElement.addEventListener('pointerdown', (event) => {
    if (mode !== 'inspect' || !activePoint) return
    const rect = renderer.domElement.getBoundingClientRect()
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(pointer, camera)
    const proxies = activePoint.markers.map((m) => m.proxy).filter(Boolean)
    if (!proxies.length) return
    const hits = raycaster.intersectObjects(proxies, false)
    if (hits.length) {
      const proxy = hits[0].object
      const line = proxy.userData.marker
      const marker = activePoint.markers.find((m) => m.line === line)
      if (marker && !marker.found) callbacks.onMarkerPick?.(marker, activePoint)
    }
  })

  /** 标记判定正确后高亮 */
  function markFound(marker) {
    marker.found = true
    if (marker.line) {
      marker.line.material.color.setHex(0x5cff9c)
      marker.line.material.opacity = 1
    }
    if (activePoint) {
      activePoint.found = activePoint.markers.filter((m) => m.found).length
    }
  }

  /** 重置所有故障标记：恢复颜色与透明度，清空 found 状态（用于清空重检） */
  function resetMarkers() {
    for (const p of inspectionPoints) {
      if (!p.markers) continue
      for (const m of p.markers) {
        m.found = false
        if (m.line) {
          const def = FAULT_KEYWORDS[m.colorType] || FAULT_KEYWORDS.white
          m.line.material.color.setHex(def.color)
          m.line.material.opacity = 0.98
        }
      }
      p.found = 0
    }
  }

  // ── 渲染循环 ──
  function render(now) {
    if (destroyed) return
    const dt = Math.min(clock.getDelta(), 0.05)
    if (mode === 'roam') {
      playerController?.update(dt)
      // 靠近检测（FSM 驱动：走行部零部件显示「名称 + 距离 + 交互条件」）
      if (playerController) {
        const ctx = getPlayerContext()
        const desc = computeNearDescriptor(ctx)
        const key = desc ? `${desc.kind}:${desc.point?.id ?? desc.partId}` : null
        if (key !== nearKey) {
          nearKey = key
          nearestPoint = desc?.point ?? null
          callbacks.onNearPoint?.(desc)
        }
      }
    } else {
      updateCameraTween(now)
      if (!cameraTween) orbitControls.update()
    }
    // 呼吸光效（仅场景模式：高亮盒隐藏时无需每帧更新材质 uniform）
    pulse += dt * 2.2
    const wave = 0.5 + 0.5 * Math.sin(pulse)
    if (mode === 'scene') {
      glowMaterial.opacity = 0.1 + wave * 0.12
      edgeMaterial.opacity = 0.7 + wave * 0.3
    }
    // 检查点脉动（漫游/场景 8 个点，开销小；仅在可见时更新）
    const pointsVisible = mode !== 'inspect' || pointGroup.visible
    if (pointsVisible) {
      inspectionPoints.forEach((p) => {
        const node = p.node
        if (!node) return
        const isNear = (p === nearestPoint)
        const s = isNear ? 1.25 + wave * 0.18 : 1 + wave * 0.1
        node.scale.setScalar(s)
        if (node.userData.ring) node.userData.ring.lookAt(camera.position)
        if (node.userData.core) {
          node.userData.core.material.opacity = isNear ? 1 : 0.85
          node.userData.core.material.color.setHex(p.markers.some((m) => m.found) ? 0x5cff9c : (isNear ? 0x7cc8ff : 0x38a8ff))
        }
      })
    }
    renderer.render(scene, camera)
    frameId = requestAnimationFrame(render)
  }
  frameId = requestAnimationFrame(render)

  // ── 模型加载 ──
  function configureMaterials(root) {
    root.traverse((o) => {
      if (!o.isMesh) return
      o.frustumCulled = true
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      mats.filter(Boolean).forEach((m) => {
        if (m.transparent) m.depthWrite = false
        if (m.map) { m.map.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy()); m.map.needsUpdate = true }
      })
    })
  }

  async function loadRail(trackBounds) {
    try {
      const railUrl = await pickModelUrl([LOCAL_RAIL, SHARED_RAIL])
      const gltf = await gltfLoader.loadAsync(railUrl)
      const template = gltf.scene
      const rb = new THREE.Box3().setFromObject(template)
      if (rb.isEmpty()) return
      const rs = rb.getSize(new THREE.Vector3())
      const scale = new THREE.Vector3(3.53 / (rs.x || 1), 0.45 / (rs.y || 1), 4.8 / (rs.z || 1))
      const group = new THREE.Group()
      for (let i = 0; i < 28; i += 1) {
        const seg = template.clone(true)
        seg.scale.copy(scale)
        seg.position.set(0, 0, (i - 13.5) * 4.45)
        group.add(seg)
      }
      group.rotation.y = Math.PI / 2
      group.updateMatrixWorld(true)
      const gb = new THREE.Box3().setFromObject(group)
      const c = gb.getCenter(new THREE.Vector3())
      const trainCenter = trackBounds.getCenter(new THREE.Vector3())
      // 轨道沿机车 X 轴铺设；横向对齐整车中心线，轨顶对齐车轮踏面最低高度。
      group.position.x += trainCenter.x - c.x
      group.position.z += trainCenter.z - c.z
      group.position.y += trackBounds.min.y - gb.max.y
      group.traverse((ch) => { if (ch.isMesh) ch.frustumCulled = true })
      scene.add(group)
    } catch { /* 轨道为辅助元素 */ }
  }

  async function load() {
    try {
      const url = await pickModelUrl([LOCAL_MODEL, SHARED_MODEL])
      callbacks.onModelSource?.(url === LOCAL_MODEL ? 'local' : 'shared', url)
      const gltf = await gltfLoader.loadAsync(url, (e) => { if (e.total) callbacks.onProgress?.(e.loaded / e.total) })
      if (destroyed) return
      locomotiveRoot = gltf.scene
      configureMaterials(locomotiveRoot)
      scene.add(locomotiveRoot)
      scene.updateMatrixWorld(true)
      modelBounds = new THREE.Box3().setFromObject(locomotiveRoot)
      await loadRail(modelBounds)

      // 碰撞与空间分区：按实测几何建立的独立碰撞代理（车体/转向架/轮对/轴箱/车钩/排障器）
      collisionResolver = createLocomotiveCollisionSystem({
        modelBounds,
        playerRadius: 0.42,
        standingHeight: 1.75,
        crouchHeight: 1.05,
      })
      collisionResolver.registerInteractionProxies(getRunningGearParts())
      // 调试图层默认隐藏，关闭时不影响教学画面
      scene.add(collisionResolver.debugGroup)

      // 接近—观察—确认状态机
      partFSM = createPartInteractionFSM({
        isItemUnlocked: (itemId) => callbacks.isItemUnlocked?.(itemId) ?? true,
        isOccluded: (part, eye) => isPartOccluded(part, eye),
      })

      playerController = new DualPlayerController({
        camera,
        domElement: renderer.domElement,
        collisionResolver,
        onLockChange: (locked) => callbacks.onPointerLockChange?.(locked),
        onPointerLockError: (e) => callbacks.onPointerLockError?.(e),
        onInteract: () => handleInteract(),
      })
      playerController.spawnFromBounds(modelBounds)

      const c = modelBounds.getCenter(new THREE.Vector3())
      const s = modelBounds.getSize(new THREE.Vector3())
      orbitControls.target.copy(c)
      startCameraMove({
        position: c.clone().add(new THREE.Vector3(s.z * 0.42, s.y * 0.42, Math.max(14, s.z * 0.72))),
        target: c.clone(),
      }, { instant: true })
      try { if (typeof renderer.compileAsync === 'function') await renderer.compileAsync(scene, camera) } catch {}
      callbacks.onLoaded?.({
        bounds: { min: modelBounds.min.toArray(), max: modelBounds.max.toArray() },
        size: s.toArray(),
      })
    } catch (error) {
      callbacks.onError?.(error)
    }
  }

  function projectToScreen(v3) {
    const v = v3.clone().project(camera)
    const rect = renderer.domElement.getBoundingClientRect()
    return { x: (v.x * 0.5 + 0.5) * rect.width, y: (-v.y * 0.5 + 0.5) * rect.height, visible: v.z < 1 }
  }

  function destroy() {
    if (destroyed) return
    destroyed = true
    cancelAnimationFrame(frameId)
    ro.disconnect()
    orbitControls.dispose()
    playerController?.dispose()
    hideHighlight()
    renderer.renderLists.dispose()
    renderer.dispose()
    renderer.forceContextLoss()
    renderer.domElement.remove()
    scene.clear()
  }

  load()

  return {
    destroy,
    focusRoute,
    resetView,
    projectToScreen,
    setMode,
    getMode: () => mode,
    buildPoints,
    inspectItem,
    markFound,
    resetMarkers,
    getInspectionPoints: () => inspectionPoints,
    getActivePoint: () => activePoint,
    exitInspect: () => setMode('scene'),
    getActiveCenter: () => lastCenter,
    getBounds: () => modelBounds,
    setPlayerInput: (v) => playerController?.setVirtualVector(v.x, v.y),
    setPlayerButton: (n, p) => playerController?.setVirtualButton(n, p),
    requestPlayerLock: () => playerController?.requestLock(),
    releasePlayerLock: () => playerController?.unlock(),
    isTouch: () => playerController?.isTouch ?? false,
    getPlayerController: () => playerController,
    /** 走行部 FSM 与零部件配置（供 UI 同步判定状态、生成对照表） */
    getPartFSM: () => partFSM,
    getRunningGearParts: () => getRunningGearParts(),
    getPartPoints: () => partPoints,
    // 调试/自动化：真实部件节点包围盒
    nodeBoxesInfo: (names) => nodeBoxes(names).map(({ name, box }) => ({
      name,
      min: box.min.toArray(),
      max: box.max.toArray(),
      center: box.getCenter(new THREE.Vector3()).toArray(),
    })),
    renderer,
    scene,
    camera,
  }
}
