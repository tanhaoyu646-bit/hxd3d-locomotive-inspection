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
import { getRunningGearParts, getRunningGearItemIds } from './parts/runningGearParts.js?v=1.7.0'
import {
  buildRunningGearStations,
  semanticPointsFor,
  markersForPoint,
  resolveStationSurfaceHit,
} from './parts/inspectionStations.js?v=1.7.0'
import { createPartInteractionFSM } from './parts/partInteractionFSM.js'
import { buildItemIndex } from './inspectionData.js'
import { SCENARIO_FAULT_POINT_IDS } from './faultScenario.js'
import { createAuthoringBox, selectAuthoringHit, conformMarkerGeometry, configureInspectOrbit } from './authoringSurface.js?v=1.7.0'
import {
  buildInspectionPoints,
  buildPartPoints,
  paintFaultMarkersOnModel,
  paintFaultMarkersOnPart,
  createFaultMarkerFromRecord,
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

/**
 * 本轮训练的假设性故障布置。只在这些真实、可从车外观察的位置放置一枚小标记；
 * 其余零部件仍保留小型交互点，可用于“确认未见异常”。
 */

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
  const defaultOrbitLimits = {
    enablePan: orbitControls.enablePan,
    minDistance: orbitControls.minDistance,
    maxDistance: orbitControls.maxDistance,
    minPolarAngle: orbitControls.minPolarAngle,
    maxPolarAngle: orbitControls.maxPolarAngle,
    minAzimuthAngle: orbitControls.minAzimuthAngle,
    maxAzimuthAngle: orbitControls.maxAzimuthAngle,
  }

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
  let stationPoints = []        // 标准观测站位；一个站位可覆盖多个语义零部件
  let interactionPoints = []    // 漫游中实际显示和可进入的点（区域点 + 标准站位 + 环节入口）
  let partPoints = []           // 走行部零部件检查点
  let routeEntryPoints = []     // 环节入口点（如「升弓电气检查」车外点）：站上去按交互键进入该环节
  let partFSM = null            // 接近—观察—确认状态机
  let activePoint = null        // 当前聚焦的检查点
  let nearestPoint = null       // 漫游时最近的检查点
  let runningGearRoute = null   // 走行部路由（零部件检查点归属）
  let nearKey = null            // 当前 near-hint 关键字，避免每帧重复回调 UI
  let roamTapStart = null       // 漫游点按：区分点击检查点与拖拽转向
  let authorTapStart = null     // 出题点按：区分表面落点与 OrbitControls 拖动
  let authorFaultSerial = 0     // 同一零部件可保存多枚故障，生成会话内唯一编号
  let scenarioMode = 'idle'     // idle | default | author | peer；登录前不预生成题库故障
  let scenarioData = null
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

  // ── 检查点标记（InstancedMesh）──
  // 原实现：每个检查点一个 Group（核心球 + 光环），89 个点 = 178 个网格 +
  // 178 份独立材质 → 每帧 178 次绘制调用（占全部 draw call 的一半以上）。
  // 现改为两个 InstancedMesh（核心球 / 光环各一个），每帧仅 2 次绘制调用；
  // 几何尺寸、颜色、脉动缩放、光环朝向相机等行为与原实现保持一致。
  let markerCoreMesh = null
  let markerRingMesh = null
  let markerPickMesh = null
  const MARKER_COLORS = {
    normal: new THREE.Color(0x38a8ff),
    near: new THREE.Color(0x7cc8ff),
    found: new THREE.Color(0x5cff9c),
  }
  /** 复用临时对象，避免每帧产生 GC 抖动 */
  const _markerM4 = new THREE.Matrix4()
  const _markerQ = new THREE.Quaternion()
  const _markerIdQ = new THREE.Quaternion()
  const _markerScale = new THREE.Vector3()
  const _markerUp = new THREE.Vector3(0, 1, 0)

  function disposeMarkerInstances() {
    for (const m of [markerCoreMesh, markerRingMesh, markerPickMesh]) {
      if (!m) continue
      pointGroup.remove(m)
      m.geometry?.dispose?.()
      m.material?.dispose?.()
      m.dispose?.()
    }
    markerCoreMesh = null
    markerRingMesh = null
    markerPickMesh = null
  }

  function buildMarkerInstances() {
    disposeMarkerInstances()
    const count = interactionPoints.length
    if (!count) return
    // 几何与材质参数沿用原 createPointMarker：核心球 r=0.028，光环 0.05~0.07
    const coreGeo = new THREE.SphereGeometry(0.028, 12, 12)
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false,
    })
    const ringGeo = new THREE.RingGeometry(0.05, 0.07, 20)
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false,
    })
    // 只用于射线拾取的透明大命中面。视觉仍是小光点，手机不必精确点到 0.03m 的球心。
    const pickGeo = new THREE.SphereGeometry(0.24, 10, 10)
    const pickMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.001, depthWrite: false })
    markerCoreMesh = new THREE.InstancedMesh(coreGeo, coreMat, count)
    markerRingMesh = new THREE.InstancedMesh(ringGeo, ringMat, count)
    markerPickMesh = new THREE.InstancedMesh(pickGeo, pickMat, count)
    for (const m of [markerCoreMesh, markerRingMesh, markerPickMesh]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      // 实例矩阵每帧变化，包围球不可靠 → 关闭视锥剔除，避免标记被误剔除
      m.frustumCulled = false
      pointGroup.add(m)
    }
    for (let i = 0; i < count; i++) {
      markerCoreMesh.setColorAt(i, MARKER_COLORS.normal)
      markerRingMesh.setColorAt(i, MARKER_COLORS.normal)
    }
    updateMarkerInstances(0)
  }

  /** 每帧更新实例矩阵（位置 / 脉动缩放 / 光环朝向相机）与实例颜色 */
  function updateMarkerInstances(wave) {
    if (!markerCoreMesh || !markerRingMesh || !markerPickMesh) return
    const count = interactionPoints.length
    for (let i = 0; i < count; i++) {
      const p = interactionPoints[i]
      const isNear = p === nearestPoint
      const s = isNear ? 1.25 + wave * 0.18 : 1 + wave * 0.1
      _markerScale.set(s, s, s)
      const pos = p.position
      // 核心球：仅缩放
      _markerM4.compose(pos, _markerIdQ, _markerScale)
      markerCoreMesh.setMatrixAt(i, _markerM4)
      // 光环：始终面向相机（等效于原实现 ring.lookAt(camera.position)）
      _markerM4.lookAt(camera.position, pos, _markerUp)
      _markerQ.setFromRotationMatrix(_markerM4)
      _markerM4.compose(pos, _markerQ, _markerScale)
      markerRingMesh.setMatrixAt(i, _markerM4)
      // 拾取代理固定略大于显示光点，不随脉动改变可点击范围。
      _markerScale.set(1.25, 1.25, 1.25)
      _markerM4.compose(pos, _markerIdQ, _markerScale)
      markerPickMesh.setMatrixAt(i, _markerM4)
      // 颜色：已发现故障标记→绿；最近点→亮蓝；其余→常规蓝
      const col = markersForPoint(p).some((m) => m.found)
        ? MARKER_COLORS.found
        : (isNear ? MARKER_COLORS.near : MARKER_COLORS.normal)
      markerCoreMesh.setColorAt(i, col)
      markerRingMesh.setColorAt(i, col)
    }
    markerCoreMesh.instanceMatrix.needsUpdate = true
    markerRingMesh.instanceMatrix.needsUpdate = true
    markerPickMesh.instanceMatrix.needsUpdate = true
    if (markerCoreMesh.instanceColor) markerCoreMesh.instanceColor.needsUpdate = true
    if (markerRingMesh.instanceColor) markerRingMesh.instanceColor.needsUpdate = true
  }

  // ── 检查点 ──
  function buildPoints(routes) {
    // 清理旧的
    while (pointGroup.children.length) {
      const c = pointGroup.children.pop()
      c.traverse?.((o) => { o.geometry?.dispose?.(); o.material?.dispose?.() })
      if (c.isInstancedMesh) c.dispose?.()
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
    regionPoints.forEach(calibrateRegionAnchor)
    partPoints.forEach(calibratePartAnchor)
    inspectionPoints = [...regionPoints, ...partPoints]

    // ── 环节入口点：升弓电气检查（车外安全确认）──
    // 车顶高压设备在出勤整备中无法登顶检视（需停电验电挂地线），原 roof 环节
    // 5 个子项均无三维点位、不可走到交互。这里在「机车外方（车侧平台位）」放一个
    // 地面交互点：站上去、面向车体后先确认安全条件；受电弓等项目仍须逐项检视。
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
    }

    // 现场作业按“人站到一个标准位置，再围绕该位置检查多个相邻零部件”组织。
    // 语义零部件继续用于故障记录与评分，但不再各自显示一个重复、抢占命中的光点。
    stationPoints = buildRunningGearStations(partPoints, modelBounds)
    interactionPoints = [...regionPoints, ...stationPoints, ...routeEntryPoints]

    // 检查点标记改为两个 InstancedMesh（178 次绘制调用 → 2 次）
    buildMarkerInstances()
    configureScenario(scenarioMode, scenarioData)
    return inspectionPoints
  }

  function clearFaultMarkers() {
    markerGroup.children.slice().forEach((child) => {
      markerGroup.remove(child)
      child.geometry?.dispose?.()
      child.material?.dispose?.()
    })
    inspectionPoints.forEach((point) => {
      point.markers = []
      point.found = 0
      point.hasScenarioFault = false
    })
    stationPoints.forEach((point) => { point.found = 0 })
  }

  /** 在登录空闲、默认题库、同伴出题、同伴答题之间切换。 */
  function configureScenario(nextMode = 'idle', nextScenario = null) {
    scenarioMode = ['default', 'author', 'peer'].includes(nextMode) ? nextMode : 'idle'
    scenarioData = nextScenario ?? null
    if (!inspectionPoints.length) return
    clearFaultMarkers()
    if (scenarioMode === 'idle') return
    if (scenarioMode === 'default') {
      inspectionPoints.forEach((point) => {
        point.hasScenarioFault = SCENARIO_FAULT_POINT_IDS.has(point.id)
      })
      inspectionPoints.filter((point) => point.hasScenarioFault).forEach(activatePointFaults)
      return
    }
    for (const record of scenarioData?.faults ?? []) {
      const point = inspectionPoints.find((candidate) => candidate.id === record.pointId)
      if (!point || point.isRouteEntry) continue
      const marker = createFaultMarkerFromRecord(point, record)
      if (!marker) continue
      if (scenarioMode === 'author' && !record.anchor?.vertices?.length) {
        const vertices = conformMarkerGeometry({
          marker,
          modelRoot: locomotiveRoot,
          authoringBox: point.authoringBox ?? point.geometryBox,
          baseNormal: marker.normal,
          raycaster,
        })
        if (vertices.length) {
          record.anchor.vertices = vertices
          callbacks.onAuthorFaultGeometry?.(record, point)
        }
      }
      point.hasScenarioFault = true
      point.markers.push(marker)
      markerGroup.add(marker.line, marker.proxy)
    }
  }

  /** 区域检查点的外部朝向。端部优先正对车头/车尾，其余按车体左右外侧。 */
  function exteriorDirectionFor(point) {
    const hint = point?.fault?.exterior
    const named = {
      'i-end': [1, 0, 0], 'ii-end': [-1, 0, 0],
      left: [0, 0, -1], right: [0, 0, 1], top: [0, 1, 0], bottom: [0, -1, 0],
    }
    if (named[hint]) return new THREE.Vector3(...named[hint])
    const c = modelBounds.getCenter(new THREE.Vector3())
    const s = modelBounds.getSize(new THREE.Vector3())
    const d = point.position.clone().sub(c)
    if (Math.abs(d.x) / Math.max(s.x, 1) > 0.33) return new THREE.Vector3(Math.sign(d.x) || 1, 0, 0)
    return new THREE.Vector3(0, 0, Math.sign(d.z) || -1)
  }

  /** 区域检查点也必须贴到最外层可见表面，不能留在机车内腔。 */
  function calibrateRegionAnchor(point) {
    if (!locomotiveRoot || !point?.geometryBox) return
    const outward = exteriorDirectionFor(point)
    const origin = point.position.clone().addScaledVector(outward, 4.5)
    raycaster.set(origin, outward.clone().negate())
    raycaster.far = 9
    const box = point.geometryBox.clone().expandByScalar(0.025)
    point.authoringBox = box.clone()
    point.orbitTarget = box.getCenter(new THREE.Vector3())
    const hit = raycaster.intersectObject(locomotiveRoot, true).find((h) => box.containsPoint(h.point))
    if (!hit) {
      const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5)
      const radius = Math.abs(outward.x) * half.x + Math.abs(outward.y) * half.y + Math.abs(outward.z) * half.z
      point.surfaceViewDirection = outward
      point.surfaceAnchor = box.getCenter(new THREE.Vector3()).addScaledVector(outward, radius + 0.06)
      point.interactionTarget = point.surfaceAnchor.clone()
      point.position.copy(point.surfaceAnchor)
      return
    }
    const normal = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
      : outward.clone()
    if (normal.dot(outward) < 0) normal.negate()
    point.surfaceNormal = normal
    point.surfaceViewDirection = outward
    point.surfaceAnchor = hit.point.clone().addScaledVector(normal, 0.018)
    point.interactionTarget = point.surfaceAnchor.clone()
    // 漫游小光点也贴在外表面；不再落在合并网格的内部语义中心。
    point.position.copy(point.surfaceAnchor)
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
    point.authoringBox = createAuthoringBox(part) ?? box.clone()
    // 检视必须围绕零部件中心旋转，不能围绕外表面锚点旋转。
    point.orbitTarget = center.clone()

    const outboard = new THREE.Vector3(0, 0, -1)
    if (part.side === 'right') outboard.set(0, 0, 1)
    else if (part.type === 'undercar') outboard.set(0, -1, 0)
    else if (part.type === 'pilot') outboard.set(part.bogie === 'front' ? 1 : -1, 0, 0)
    const origin = center.clone().addScaledVector(outboard, 3.5)
    raycaster.set(origin, outboard.clone().negate())
    raycaster.far = 7
    const hit = raycaster.intersectObject(locomotiveRoot, true).find((h) => box.containsPoint(h.point))
    if (hit) {
      const normal = hit.face
        ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
        : outboard.clone()
      if (normal.dot(outboard) < 0) normal.negate()
      point.surfaceNormal = normal
      point.surfaceAnchor = hit.point.clone().addScaledVector(normal, 0.018)
      point.interactionTarget = point.surfaceAnchor.clone()
      point.position.copy(point.surfaceAnchor)
    } else {
      // 合并网格在极少数区域找不到严格命中面时，也不能把交互点留在零部件内部。
      const half = point.authoringBox.getSize(new THREE.Vector3()).multiplyScalar(0.5)
      const radius = Math.abs(outboard.x) * half.x + Math.abs(outboard.y) * half.y + Math.abs(outboard.z) * half.z
      point.surfaceAnchor = point.authoringBox.getCenter(new THREE.Vector3()).addScaledVector(outboard, radius + 0.06)
      point.interactionTarget = point.surfaceAnchor.clone()
      point.position.copy(point.surfaceAnchor)
    }
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
    if (!point.hasScenarioFault) return []
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

  /** 标准站位是独立入口，不继承某个代表零部件的 FSM 状态。 */
  function evaluateStationEntry(point, ctx, { skipFacing = false } = {}) {
    const stand = point.standPosition ?? point.position
    const dx = stand.x - ctx.position.x
    const dz = stand.z - ctx.position.z
    const distance = Math.hypot(dx, dz)
    const inZone = distance <= (point.approachRadius ?? 1.2)
    const look = (point.lookTarget ?? point.orbitTarget ?? point.position).clone().sub(ctx.position).setY(0)
    const facing = look.lengthSq() < 1e-6 ? 1 : ctx.forward.dot(look.normalize())
    const facingOk = skipFacing || facing >= (point.facingThreshold ?? 0.32)
    const crouchOk = !point.requireCrouch || Boolean(ctx.crouching)
    const conditions = [
      { code: 'inZone', met: inZone, label: '到达标准站位', detail: `请走到“${point.stationShortName}”光点附近` },
      { code: 'facing', met: facingOk, label: '面向检查对象', detail: '请转向该站位对应的走行部零部件' },
      { code: 'crouch', met: crouchOk, label: '下蹲观察', detail: '该站位需要先下蹲再交互' },
    ]
    const unmet = conditions.filter((condition) => !condition.met)
    return {
      canEnter: !unmet.length,
      conditions,
      unmet,
      stage: 'ready',
      stageMeta: { label: '标准检查站位', hint: unmet[0]?.detail ?? '可以进入检视' },
      distance,
    }
  }

  /**
   * HUD 与按键共用同一个目标解析器：按准星指向优先，再按距离排序。
   * 这样端部同一 x/z 上的车钩、风管、玻璃和灯具不会再按数组顺序互相抢占。
   */
  function resolveInteractionTarget(ctx, { hud = false } = {}) {
    const eye = ctx.position.clone().add(new THREE.Vector3(0, ctx.eyeHeight ?? 1.7, 0))
    const forward = getCameraForward3D()
    const minAim = 0.55
    let best = null
    for (const point of interactionPoints) {
      const target = point.interactionTarget ?? point.position
      const distanceTarget = point.isStationPoint ? (point.standPosition ?? point.position) : target
      const dx = distanceTarget.x - ctx.position.x
      const dz = distanceTarget.z - ctx.position.z
      const horizontalDistance = Math.hypot(dx, dz)
      const maxDistance = point.isStationPoint
        ? (point.approachRadius ?? 1.2) + (hud ? 2.0 : 0.5)
        : point.isPartPoint
        ? (point.part.approach?.maxDistance ?? 3) + (hud ? 2.0 : 0.65)
        : NEAR_DISTANCE + (hud ? 0.8 : 0)
      if (horizontalDistance > maxDistance) continue
      const toTarget = target.clone().sub(eye)
      const spatialDistance = toTarget.length()
      if (spatialDistance < 0.05) continue
      const aim = forward.dot(toTarget.multiplyScalar(1 / spatialDistance))
      if (aim < minAim) continue
      // 准星方向远比距离重要；距离只在近似同向的候选之间消歧。
      // HUD 与实际按键都优先选择“已站到允许站位”的那个零部件，
      // 避免相邻轴箱/弹簧的目标抢占后又提示“请走到车体侧站位”。
      const inZone = point.isStationPoint
        ? evaluateStationEntry(point, ctx, { skipFacing: true }).conditions.some((c) => c.code === 'inZone' && c.met)
        : point.isPartPoint && partFSM
          ? partFSM.evaluate(point, ctx, { skipOcclusion: true }).conditions.some((c) => c.code === 'inZone' && c.met)
        : false
      const score = aim * 10 - horizontalDistance * 0.12 - spatialDistance * 0.015 + (inZone ? 12 : 0)
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
    for (const p of interactionPoints) {
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
    if (p.isStationPoint) {
      const ev = evaluateStationEntry(p, ctx)
      const unmet = ev.unmet[0]
      return {
        kind: 'station', point: p, distance: selected.distance,
        name: p.stationLabel, shortName: p.stationShortName,
        stage: ev.stage, stageLabel: ev.stageMeta.label, stageHint: ev.stageMeta.hint,
        conditions: ev.conditions, canEnter: ev.canEnter,
        unmetLabel: unmet ? unmet.label : null,
      }
    }
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
    // 标准站位本身不承载答案；进入后激活/展示该站位覆盖的具体零部件故障。
    semanticPointsFor(point).forEach(activatePointFaults)
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
      // 区域点使用校准时的车外朝向，缓冲器、挡风玻璃等不会再把镜头推进车体内侧。
      offsetDir = (point.surfaceViewDirection?.clone?.() ?? new THREE.Vector3(0.8, 0.35, 1))
      offsetDir.y += 0.22
      offsetDir.normalize()
    }
    const target = point.orbitTarget?.clone?.()
      ?? point.interactionTarget?.clone?.()
      ?? point.position.clone()
    const position = target.clone().addScaledVector(offsetDir, dist)
    // 标准观测点：固定旋转中心、禁止平移，并把缩放限制在部件附近。
    // 检视/出题均允许绕零部件完整一周，才能观察轴向背面。
    configureInspectOrbit(orbitControls, dist)
    startCameraMove({ position, target }, {
      duration: instant ? 0 : 820,
      instant,
      onDone: () => {
        orbitControls.update()
      },
    })
    return true
  }

  function restoreOrbitLimits() {
    Object.assign(orbitControls, defaultOrbitLimits)
  }

  // ── 模式 ──
  function setMode(newMode) {
    if (newMode === mode) return
    if (mode === 'roam') {
      playerController?.disable()
      orbitControls.enabled = true
    }
    if (mode === 'inspect') {
      restoreOrbitLimits()
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
    if (p.isStationPoint) {
      const ev = evaluateStationEntry(p, ctx)
      if (!ev.canEnter) {
        callbacks.onToast?.(ev.unmet[0]?.detail || '请到达标准站位并面向检查对象')
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

  /** 直接点三维光点：点击即代表已对准，但仍必须处于可达站位，避免远距离跳转。 */
  function handlePointTap(point) {
    if (!point || mode !== 'roam' || !playerController) return
    const ctx = getPlayerContext()
    const target = point.interactionTarget ?? point.position
    const distanceTarget = point.isStationPoint ? (point.standPosition ?? point.position) : target
    const distance = Math.hypot(distanceTarget.x - ctx.position.x, distanceTarget.z - ctx.position.z)
    const maxDistance = point.isStationPoint
      ? (point.approachRadius ?? 1.2) + 0.5
      : point.isPartPoint
      ? (point.part.approach?.maxDistance ?? 3) + 0.65
      : NEAR_DISTANCE + 0.65
    if (distance > maxDistance) {
      callbacks.onToast?.('请先靠近该检查点，再点击进入检视')
      return
    }
    if (point.isRouteEntry && !callbacks.isRouteUnlocked?.(point.routeId)) {
      callbacks.onToast?.('该环节尚未解锁')
      return
    }
    if (point.isStationPoint) {
      const tappedCtx = { ...ctx, forward: target.clone().sub(ctx.position).setY(0).normalize() }
      const ev = evaluateStationEntry(point, tappedCtx, { skipFacing: true })
      if (!ev.canEnter) {
        callbacks.onToast?.(ev.unmet[0]?.detail || '请满足站位条件后再交互')
        return
      }
      setMode('inspect')
      focusOnPoint(point)
      callbacks.onInspectEnter?.(point)
      return
    }
    if (point.isPartPoint) {
      // 点中可见光点本身已经证明朝向和视线成立；仍保留站位、距离和蹲下条件。
      const tappedCtx = { ...ctx, forward: target.clone().sub(ctx.position).setY(0).normalize() }
      const ev = partFSM.evaluate(point, tappedCtx, { skipOcclusion: true })
      if (!ev.canEnter) {
        callbacks.onToast?.(ev.unmet[0]?.detail || ev.stageMeta.hint || '请满足检查条件后再交互')
        return
      }
      partFSM.beginInspect(point.part)
    }
    setMode('inspect')
    focusOnPoint(point)
    callbacks.onInspectEnter?.(point)
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
  function onInspectPointerDown(event) {
    if (mode !== 'inspect' || !activePoint) return
    if (scenarioMode === 'author') {
      if (event.button > 0) return
      authorTapStart = {
        id: event.pointerId,
        pointerType: event.pointerType || 'mouse',
        x: event.clientX,
        y: event.clientY,
        time: performance.now(),
      }
      return
    }
    const rect = renderer.domElement.getBoundingClientRect()
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(pointer, camera)
    const activeMarkers = markersForPoint(activePoint)
    const proxies = activeMarkers.map((m) => m.proxy).filter(Boolean)
    if (!proxies.length) return
    const hits = raycaster.intersectObjects(proxies, false)
    if (hits.length) {
      const proxy = hits[0].object
      const line = proxy.userData.marker
      const marker = activeMarkers.find((m) => m.line === line)
      if (marker && !marker.found) {
        const owner = semanticPointsFor(activePoint).find((candidate) => candidate.markers?.includes(marker)) ?? activePoint
        callbacks.onMarkerPick?.(marker, owner, activePoint)
      }
    }
  }
  renderer.domElement.addEventListener('pointerdown', onInspectPointerDown)

  function onInspectPointerUp(event) {
    if (!authorTapStart || authorTapStart.id !== event.pointerId) return
    const start = authorTapStart
    authorTapStart = null
    if (mode !== 'inspect' || scenarioMode !== 'author' || !activePoint) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    const touch = start.pointerType === 'touch' || start.pointerType === 'pen'
    const maxMove = touch ? 18 : 9
    const maxDuration = touch ? 900 : 650
    if (dx * dx + dy * dy > maxMove * maxMove || performance.now() - start.time > maxDuration) return
    if (activePoint.isRouteEntry) {
      callbacks.onToast?.('安全确认入口不能设置假设故障')
      return
    }

    const rect = renderer.domElement.getBoundingClientRect()
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(pointer, camera)

    // 点击已有标记时循环该零部件允许的故障类型，不再重复叠加标记。
    const activeMarkers = markersForPoint(activePoint)
    const markerHit = raycaster.intersectObjects(activeMarkers.map((marker) => marker.proxy), false)[0]
    if (markerHit) {
      const line = markerHit.object.userData.marker
      const marker = activeMarkers.find((candidate) => candidate.line === line)
      const owner = semanticPointsFor(activePoint).find((candidate) => candidate.markers?.includes(marker)) ?? activePoint
      if (marker) callbacks.onAuthorMarkerTap?.(marker, owner, activePoint)
      return
    }

    // 在最前方同一可见表面层内解析具体零部件。站位只负责镜头入口，
    // 故障答案仍直接绑定到轮对、轴箱、悬挂、制动盘等语义零部件。
    const hits = raycaster.intersectObject(locomotiveRoot, true)
    const resolved = activePoint.isStationPoint
      ? resolveStationSurfaceHit(activePoint, hits)
      : null
    const targetPoint = resolved?.point ?? (activePoint.isStationPoint ? null : activePoint)
    const hit = resolved?.hit ?? (targetPoint
      ? selectAuthoringHit(hits, targetPoint.authoringBox ?? targetPoint.geometryBox, 0.085, 0.42)
      : null)
    if (!hit) {
      callbacks.onToast?.('该位置不属于当前站位的可出题零部件，请点击可见的轮对、轴箱、悬挂或制动部件表面')
      return
    }
    let normal = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
      : targetPoint.surfaceNormal?.clone?.() ?? new THREE.Vector3(0, 0, 1)
    const towardCamera = camera.position.clone().sub(hit.point).normalize()
    if (normal.dot(towardCamera) < 0) normal.negate()
    let tangent = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
    tangent.addScaledVector(normal, -tangent.dot(normal))
    if (tangent.lengthSq() < 1e-6) tangent = new THREE.Vector3().crossVectors(normal, new THREE.Vector3(0, 1, 0))
    tangent.normalize()
    const surfacePoint = hit.point.clone()
    const faultType = callbacks.getAuthorFaultType?.(targetPoint)
    if (!faultType) {
      callbacks.onToast?.('该检查点尚未配置可用的故障类型')
      return
    }
    const record = {
      faultId: `F-${targetPoint.id}-${Date.now().toString(36)}-${(++authorFaultSerial).toString(36)}`,
      pointId: targetPoint.id,
      partId: targetPoint.part?.partId ?? '',
      itemId: targetPoint.itemId ?? targetPoint.item?.id ?? '',
      faultType,
      anchor: {
        position: surfacePoint.toArray(),
        normal: normal.toArray(),
        tangent: tangent.toArray(),
      },
      glyph: { size: 0.072 },
    }
    const marker = createFaultMarkerFromRecord(targetPoint, record)
    if (!marker) return
    const vertices = conformMarkerGeometry({
      marker,
      modelRoot: locomotiveRoot,
      authoringBox: targetPoint.authoringBox ?? targetPoint.geometryBox,
      baseNormal: normal,
      raycaster,
    })
    if (vertices.length) record.anchor.vertices = vertices
    targetPoint.hasScenarioFault = true
    targetPoint.markers.push(marker)
    markerGroup.add(marker.line, marker.proxy)
    callbacks.onAuthorFaultPlaced?.(record, targetPoint, marker, activePoint)
  }
  renderer.domElement.addEventListener('pointerup', onInspectPointerUp)
  const onInspectPointerCancel = () => { authorTapStart = null }
  renderer.domElement.addEventListener('pointercancel', onInspectPointerCancel)

  function onRoamPointerDown(event) {
    if (mode !== 'roam' || event.button > 0 || document.pointerLockElement === renderer.domElement) return
    roamTapStart = { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now() }
  }
  function onRoamPointerUp(event) {
    if (!roamTapStart || roamTapStart.id !== event.pointerId || mode !== 'roam') return
    const dx = event.clientX - roamTapStart.x
    const dy = event.clientY - roamTapStart.y
    const elapsed = performance.now() - roamTapStart.time
    roamTapStart = null
    if (dx * dx + dy * dy > 196 || elapsed > 500 || !markerPickMesh) return
    const rect = renderer.domElement.getBoundingClientRect()
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(pointer, camera)
    const hit = raycaster.intersectObject(markerPickMesh, false)[0]
    const point = hit?.instanceId == null ? null : interactionPoints[hit.instanceId]
    if (point) handlePointTap(point)
  }
  renderer.domElement.addEventListener('pointerdown', onRoamPointerDown)
  renderer.domElement.addEventListener('pointerup', onRoamPointerUp)

  /** 标记判定正确后高亮 */
  function markFound(marker) {
    marker.found = true
    if (marker.line) {
      marker.line.material.color.setHex(0x5cff9c)
      marker.line.material.opacity = 1
    }
    if (activePoint) activePoint.found = markersForPoint(activePoint).filter((m) => m.found).length
  }

  /** 重置所有故障标记：恢复颜色与透明度，清空 found 状态（用于清空重检） */
  function resetMarkers() {
    for (const p of inspectionPoints) {
      if (!p.markers) continue
      for (const m of p.markers) {
        m.found = false
        if (m.line) {
          const def = FAULT_KEYWORDS[m.colorType] || FAULT_KEYWORDS.white
          m.line.material.color.setHex(m.color ?? def.color)
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
        // 同一部件在“未到位 / 已到位”之间切换时也必须刷新 HUD，
        // 否则手机交互键会停留在旧颜色，无法准确反映当前可交互状态。
        const key = desc
          ? `${desc.kind}:${desc.point?.id ?? desc.partId}:${desc.stage ?? ''}:${desc.canEnter}:${desc.unmetLabel ?? ''}`
          : null
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
    // 检查点脉动：InstancedMesh 一次性更新（每帧仅 2 次绘制调用），仅在可见时更新
    const pointsVisible = mode !== 'inspect' || pointGroup.visible
    if (pointsVisible) updateMarkerInstances(wave)
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
    renderer.domElement.removeEventListener('pointerdown', onInspectPointerDown)
    renderer.domElement.removeEventListener('pointerup', onInspectPointerUp)
    renderer.domElement.removeEventListener('pointercancel', onInspectPointerCancel)
    renderer.domElement.removeEventListener('pointerdown', onRoamPointerDown)
    renderer.domElement.removeEventListener('pointerup', onRoamPointerUp)
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
    configureScenario,
    getScenarioMode: () => scenarioMode,
    inspectItem,
    markFound,
    resetMarkers,
    getInspectionPoints: () => inspectionPoints,
    getStationPoints: () => stationPoints,
    getInteractionPoints: () => interactionPoints,
    getMarkersForPoint: (point) => markersForPoint(point),
    getFaultStats: () => {
      const points = inspectionPoints.filter((p) => p.hasScenarioFault)
      return {
        found: points.reduce((sum, p) => sum + (p.markers?.filter((m) => m.found).length ?? 0), 0),
        total: points.reduce((sum, p) => sum + (p.markers?.length ?? 0), 0),
      }
    },
    getActivePoint: () => activePoint,
    enterPointForTest: (point) => {
      if (!point) return false
      setMode('inspect')
      focusOnPoint(point, { instant: true })
      callbacks.onInspectEnter?.(point)
      return true
    },
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
