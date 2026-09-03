/**
 * 检查点叠加 + 故障标记绘制（V3）
 * ---------------------------------------------------------------------------
 * 重要原则：不修改、不裁剪原孪生平台的三维模型。
 * 只在原模型之上"叠加"两层内容：
 *
 *   1. 检查点（InspectionPoint）
 *      每个带故障配置的检查项，在原模型对应区域生成一个检查点。
 *      检查点以发光小球 + 光环的形式贴在模型表面，漫游靠近可交互。
 *
 *   2. 故障标记（FaultMarker）
 *      在检查点周边、原模型**真实表面**上绘制极小的短横线：
 *        · 结构件 → 白色短横线（模拟裂纹）
 *        · 电气件 → 红色短横线 / 红点（模拟烧损）
 *      标记位置优先选隐蔽方向（朝下、朝内、背面），
 *      玩家必须放大并旋转视角才能发现。
 *
 * 学生流程：
 *   漫游靠近检查点 → 按 E（或点虚拟交互键）→ 相机聚焦放大该点
 *   → 旋转视角寻找标记 → 点击发现的标记 → 填报规范化故障活件
 *   → 故障类型与符号语义匹配后计分
 */
import * as THREE from 'three'

/**
 * 机车走行部故障假设符号。形状是判定依据，颜色只用于还原粉笔颜色。
 * 对应教学资料：白线裂纹、白片擦伤、白环剥离、红片烧损、白叉松动、白三角滴漏。
 */
export const FAULT_TYPES = Object.freeze({
  crack: { label: '裂纹或焊接处裂损', shape: 'line', color: 0xffffff, keywords: ['裂纹', '焊缝裂损', '焊缝开裂', '裂损'] },
  'tread-scratch': { label: '轮对踏面擦伤', shape: 'square', color: 0xffffff, keywords: ['踏面擦伤', '擦伤'] },
  'tread-peel': { label: '轮对踏面剥离', shape: 'ring', color: 0xffffff, keywords: ['踏面剥离', '剥离'] },
  burn: { label: '部件烧损', shape: 'square', color: 0xff3b3b, keywords: ['烧损', '烧蚀'] },
  'loose-bolt': { label: '螺栓松动', shape: 'cross', color: 0xffffff, keywords: ['螺栓松动', '松动'] },
  leak: { label: '油、水、风管路滴漏', shape: 'triangle', color: 0xffffff, keywords: ['滴漏', '漏泄', '漏油', '漏气', '漏水'] },
})

/** 兼容旧区域配置与旧存档；新配置一律使用 faultType。 */
export const FAULT_KEYWORDS = {
  ...FAULT_TYPES,
  white: FAULT_TYPES.crack,
  red: FAULT_TYPES.burn,
}

export function resolveFaultSpec(spec = {}) {
  let faultType = spec.faultType
  if (!faultType) {
    if (spec.shape === 'triangle') faultType = 'leak'
    else if (spec.shape === 'ring') faultType = 'tread-peel'
    else if (spec.shape === 'cross') faultType = 'loose-bolt'
    else faultType = spec.colorType === 'red' ? 'burn' : 'crack'
  }
  const def = FAULT_TYPES[faultType] ?? FAULT_TYPES.crack
  return {
    ...spec,
    faultType,
    shape: spec.shape ?? def.shape,
    color: def.color,
    label: def.label,
    keywords: spec.keywords ?? def.keywords,
    colorType: def.color === 0xff3b3b ? 'red' : 'white',
  }
}

/** 部件类型：决定故障标记颜色配比 */
export const PART_TYPES = {
  STRUCTURAL: 'structural', // 结构件：白色裂纹
  ELECTRICAL: 'electrical', // 电气件：红色烧损为主
  BRAKE: 'brake',           // 制动件：白色裂纹 + 渗漏
}

/**
 * 根据归一化区域计算世界坐标中心
 * @param {THREE.Box3} bounds 模型包围盒
 * @param {{u:number[],v:number[],w:number[]}} region
 */
export function regionCenter(bounds, region) {
  const size = bounds.getSize(new THREE.Vector3())
  return new THREE.Vector3(
    bounds.min.x + size.x * ((region.u[0] + region.u[1]) / 2),
    bounds.min.y + size.y * ((region.v[0] + region.v[1]) / 2),
    bounds.min.z + size.z * ((region.w[0] + region.w[1]) / 2),
  )
}

export function regionToBox(bounds, region) {
  const size = bounds.getSize(new THREE.Vector3())
  return new THREE.Box3(
    new THREE.Vector3(
      bounds.min.x + size.x * region.u[0],
      bounds.min.y + size.y * region.v[0],
      bounds.min.z + size.z * region.w[0],
    ),
    new THREE.Vector3(
      bounds.min.x + size.x * region.u[1],
      bounds.min.y + size.y * region.v[1],
      bounds.min.z + size.z * region.w[1],
    ),
  )
}

/**
 * 构建全部检查点
 * @returns {Array} 每个检查点 { id, item, route, position, region, partType, faults }
 */
export function buildInspectionPoints(routes, bounds, opts = {}) {
  const points = []
  if (!bounds) return points
  /** 走行部检查项已改由零部件配置驱动，这里排除，避免重复建点 */
  const exclude = opts.excludeItems ?? null
  routes.forEach((route) => {
    route.items.forEach((item) => {
      if (!item.fault?.region) return
      if (exclude && exclude.has(item.id)) return
      points.push({
      id: item.id,
      item,
      route,
      reportPartName: item.fault.reportPartName ?? item.name,
      position: regionCenter(bounds, item.fault.region),
      region: item.fault.region,
      geometryBox: regionToBox(bounds, item.fault.region),
        partType: item.fault.partType ?? PART_TYPES.STRUCTURAL,
        faults: item.fault.faults ?? [],
        markers: [],
        markerGroup: null,
        found: 0,
      })
    })
  })
  return points
}

/**
 * 由走行部零部件配置生成检查点
 * 与 buildInspectionPoints 的区别：位置来自零部件实测几何，
 * 而不是检查项里手写的归一化区域；每个零部件一个独立检查点。
 *
 * @param {Array} parts           runningGearParts 的零部件实例
 * @param {Object} route          所属部位（走行部路由）
 * @param {Map} itemIndex         inspectionData 的 buildItemIndex() 结果
 * @returns {Array} 检查点数组
 */
export function buildPartPoints(parts, route, itemIndex) {
  return parts.map((part) => {
    const entry = itemIndex.get(part.itemId)
    return {
      id: part.partId,
      itemId: part.itemId,
      item: entry?.item ?? null,
      route,
      /** 零部件配置，交互状态机与标记绘制都依赖它 */
      part,
      position: new THREE.Vector3(part.centerWorld.x, part.centerWorld.y, part.centerWorld.z),
      region: null,
      partType: part.partType ?? PART_TYPES.STRUCTURAL,
      faults: part.judge?.faults ?? [],
      markers: [],
      markerGroup: null,
      found: 0,
      /** 区分：零部件检查点 vs 区域检查点 */
      isPartPoint: true,
    }
  })
}

/** 可复现随机数 */
function mulberry32(seed) {
  let t = seed >>> 0
  return function () {
    t |= 0
    t = (t + 0x6D2B79F5) | 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 故障符号以线框叠加在模型表面：避免改变原 GLB，同时用形状区分不同故障。
 * line=线条、triangle=三角、ring=环形、cross=叉形；颜色仍由故障类别决定。
 */
function createFaultGlyph({ surfacePoint, normal, tangent, length, color, shape = 'line' }) {
  const n = normal.clone().normalize()
  const t = tangent.clone().normalize()
  const b = new THREE.Vector3().crossVectors(n, t).normalize()
  const lift = (v) => v.addScaledVector(n, 0.006)
  let points
  let Type = THREE.Line

  if (shape === 'square') {
    const r = length * 0.58
    const corners = [
      [-r, -r], [r, -r], [r, r], [-r, r],
    ].map(([u, v]) => lift(surfacePoint.clone().addScaledVector(t, u).addScaledVector(b, v)))
    const geometry = new THREE.BufferGeometry().setFromPoints(corners)
    geometry.setIndex([0, 1, 2, 0, 2, 3])
    return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.88, depthTest: true, side: THREE.DoubleSide,
    }))
  }

  if (shape === 'triangle') {
    const r = length * 0.62
    points = [0, 1, 2, 0].map((i) => {
      const a = -Math.PI / 2 + i * (Math.PI * 2 / 3)
      return lift(surfacePoint.clone().addScaledVector(t, Math.cos(a) * r).addScaledVector(b, Math.sin(a) * r))
    })
    Type = THREE.Line
  } else if (shape === 'ring') {
    const r = length * 0.52
    points = Array.from({ length: 13 }, (_, i) => {
      const a = i * (Math.PI * 2 / 12)
      return lift(surfacePoint.clone().addScaledVector(t, Math.cos(a) * r).addScaledVector(b, Math.sin(a) * r))
    })
    Type = THREE.Line
  } else if (shape === 'cross') {
    const r = length * 0.55
    points = [
      lift(surfacePoint.clone().addScaledVector(t, -r)), lift(surfacePoint.clone().addScaledVector(t, r)),
      lift(surfacePoint.clone().addScaledVector(b, -r)), lift(surfacePoint.clone().addScaledVector(b, r)),
    ]
    Type = THREE.LineSegments
  } else {
    points = [
      lift(surfacePoint.clone().addScaledVector(t, -length / 2)),
      lift(surfacePoint.clone().addScaledVector(t, length / 2)),
    ]
  }

  return new Type(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.98, depthTest: true }),
  )
}

/**
 * 在检查点周边、原模型真实表面上绘制故障标记
 * 位置优先选隐蔽方向（朝下 / 朝内 / 背面），需旋转视角才能发现
 *
 * @param {THREE.Object3D} modelRoot 原模型根（不修改其几何）
 * @param {Object} point 检查点
 * @param {Object} [opts] { seed }
 * @returns {Array} 标记数组
 */
export function paintFaultMarkersOnModel(modelRoot, point, opts = {}) {
  const rng = mulberry32(Math.floor((opts.seed ?? Math.random()) * 1e9))
  const markers = []
  if (!modelRoot || !point) return markers

  // 统计需要画的标记总数
  const plan = []
  for (const f of point.faults) {
    const count = f.count ?? 1
    for (let i = 0; i < count; i += 1) plan.push(f)
  }
  if (!plan.length) plan.push({ colorType: 'white', keywords: FAULT_KEYWORDS.white.keywords })

  // 隐蔽方向候选：优先朝下、朝车体内侧、朝车长内侧
  const hiddenDirs = [
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, -0.7, 0.7),
    new THREE.Vector3(0, -0.7, -0.7),
    new THREE.Vector3(0.35, -0.55, 0.6),
    new THREE.Vector3(-0.35, -0.55, -0.6),
    new THREE.Vector3(0.5, -0.3, 0.8),
    new THREE.Vector3(-0.5, -0.3, -0.8),
    new THREE.Vector3(0.85, -0.2, 0.3),
    new THREE.Vector3(-0.85, -0.2, -0.3),
  ]

  const raycaster = new THREE.Raycaster()
  raycaster.far = 12

  for (const spec of plan) {
    const resolved = resolveFaultSpec(spec)
    const { colorType, keywords, faultType } = resolved

    // 从检查点向隐蔽方向发射线，命中模型表面即为标记位置
    let hit = null
    const shuffled = hiddenDirs.slice()
    // 简单洗牌
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1))
      const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp
    }
    for (const dir of shuffled) {
      const jitter = new THREE.Vector3(
        (rng() - 0.5) * 0.5,
        (rng() - 0.5) * 0.3,
        (rng() - 0.5) * 0.5,
      )
      const d = dir.clone().add(jitter).normalize()
      raycaster.set(point.position.clone(), d)
      const hits = raycaster.intersectObject(modelRoot, true)
      const scoped = point.geometryBox
        ? hits.find((candidate) => point.geometryBox.clone().expandByScalar(0.03).containsPoint(candidate.point))
        : hits[0]
      if (scoped) { hit = scoped; break }
    }
    if (!hit) continue

    const surfacePoint = hit.point.clone()
    const normal = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
      : new THREE.Vector3(0, 1, 0)

    // 生成表面故障符号（沿表面切线方向）
    const length = 0.075 + rng() * 0.045
    const helper = Math.abs(normal.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
    const tangent = new THREE.Vector3().crossVectors(normal, helper).normalize()
    const shape = resolved.shape
    const line = createFaultGlyph({ surfacePoint, normal, tangent, length, color: resolved.color, shape })
    line.renderOrder = 20
    line.userData = {
      isFaultMarker: true,
      colorType,
      keywords,
      label: resolved.label,
      faultType,
      shape,
      pointId: point.id,
      found: false,
    }

    // 拾取代理（略大、透明），便于点击
    const proxyGeo = new THREE.SphereGeometry(0.085, 8, 8)
    const proxyMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
    const proxy = new THREE.Mesh(proxyGeo, proxyMat)
    proxy.position.copy(surfacePoint)
    proxy.renderOrder = 21
    proxy.userData = { isFaultProxy: true, marker: line }

    markers.push({ line, proxy, colorType, faultType, label: resolved.label, keywords, shape, found: false })
  }

  return markers
}

/**
 * 在**指定零部件的表面**上绘制故障标记
 * ---------------------------------------------------------------------------
 * 与 paintFaultMarkersOnModel 的区别：
 *   旧函数从检查点向「隐蔽方向」随机发射线，命中哪里算哪里，
 *   结果标记经常落到不相关的车体表面上（例如走行部检查项的标记出现在侧墙）。
 *
 * 本函数把标记约束在零部件自身的低复杂度表面代理范围内：
 *   1. 先按部件朝向确定「学生观察方向」（outboard）
 *      左侧件→朝 −Z，右侧件→朝 +Z，车下件→朝下，端部件→朝车外
 *   2. 在部件代理范围内随机取采样点，沿 −outboard 外侧向部件发射线
 *      命中原模型表面即作为标记落点
 *   3. 落点必须落在部件代理尺寸范围内；未命中则换采样点，不在空气中补画
 */
export function paintFaultMarkersOnPart(modelRoot, point, opts = {}) {
  const part = point.part
  if (!part) return paintFaultMarkersOnModel(modelRoot, point, opts)

  const rng = mulberry32(Math.floor((opts.seed ?? Math.random()) * 1e9))
  const markers = []
  const center = new THREE.Vector3(part.centerWorld.x, part.centerWorld.y, part.centerWorld.z)
  const [sx, sy, sz] = part.proxySize

  // 观察方向：学生站位看向部件的方向的反向（即从部件指向学生）
  const outboard = new THREE.Vector3()
  if (part.type === 'undercar') outboard.set(0, 1, 0)          // 车下件：学生从下往上看
  else if (part.type === 'pilot') outboard.set(part.bogie === 'front' ? 1 : -1, 0, 0)
  else if (part.side === 'left') outboard.set(0, 0, -1)
  else if (part.side === 'right') outboard.set(0, 0, 1)
  else outboard.set(0, 0, -1)
  outboard.normalize()

  // 计划绘制的标记
  const plan = []
  for (const f of part.judge?.faults ?? []) {
    for (let i = 0; i < (f.count ?? 1); i += 1) plan.push(f)
  }
  if (!plan.length) return markers

  const raycaster = new THREE.Raycaster()
  raycaster.far = 6
  /** 使用已校准几何盒；没有校准结果时才采用声明代理盒。 */
  const allowedBox = point.geometryBox?.clone?.() ?? new THREE.Box3(
    center.clone().add(new THREE.Vector3(-sx / 2, -sy / 2, -sz / 2)),
    center.clone().add(new THREE.Vector3(sx / 2, sy / 2, sz / 2)),
  )
  allowedBox.expandByScalar(0.035)

  for (const spec of plan) {
    const resolved = resolveFaultSpec(spec)
    const { colorType, keywords, faultType } = resolved

    const tread = spec.surface === 'tread'
    const castDir = tread ? new THREE.Vector3(0, -1, 0) : outboard.clone().negate()
    let surfacePoint = null
    let normal = outboard.clone()
    // 合并网格局部可能存在缝隙，最多换 12 个采样点，但绝不退回到虚拟盒表面。
    for (let attempt = 0; attempt < 12 && !surfacePoint; attempt += 1) {
      const sample = center.clone().add(new THREE.Vector3(
        (rng() - 0.5) * sx * 0.7,
        (rng() - 0.5) * sy * 0.7,
        (rng() - 0.5) * sz * 0.7,
      ))
      const origin = tread
        ? sample.clone().setY(allowedBox.max.y + 1.5)
        : sample.clone().addScaledVector(outboard, 2.2)
      raycaster.set(origin, castDir)
      const hit = raycaster.intersectObject(modelRoot, true).find((h) => allowedBox.containsPoint(h.point))
      if (hit) {
        surfacePoint = hit.point.clone()
        if (hit.face) normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
      }
    }
    // 没有命中本部件真实表面就不画，避免标记漂浮或落到相邻部件。
    if (!surfacePoint) continue

    const length = 0.075 + rng() * 0.045
    const helper = Math.abs(normal.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
    const tangent = new THREE.Vector3().crossVectors(normal, helper).normalize()
    const shape = resolved.shape
    const line = createFaultGlyph({ surfacePoint, normal, tangent, length, color: resolved.color, shape })
    line.renderOrder = 20
    line.userData = {
      isFaultMarker: true, colorType, faultType, keywords, label: resolved.label, shape,
      pointId: point.id, partId: part.partId, found: false,
    }

    const proxy = new THREE.Mesh(
      new THREE.SphereGeometry(0.085, 8, 8),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    )
    proxy.position.copy(surfacePoint)
    proxy.renderOrder = 21
    proxy.userData = { isFaultProxy: true, marker: line }

    markers.push({ line, proxy, colorType, faultType, label: resolved.label, keywords, shape, found: false })
  }

  return markers
}

/** 创建检查点可视化标记（小发光球 + 细光环）
 *  注意：标记要"小而半透明"，避免遮住部件表面的细小故障标记（裂纹/烧损） */
export function createPointMarker(point, index) {
  const group = new THREE.Group()
  group.name = `InspectionPoint_${point.id}`

  // 核心小球（缩小到 0.028，避免遮挡部件表面）
  const coreGeo = new THREE.SphereGeometry(0.028, 12, 12)
  const coreMat = new THREE.MeshBasicMaterial({
    color: 0x38a8ff, transparent: true, opacity: 0.72, depthWrite: false,
  })
  const core = new THREE.Mesh(coreGeo, coreMat)
  group.add(core)

  // 外圈细光环（缩小到 0.05~0.07）
  const ringGeo = new THREE.RingGeometry(0.05, 0.07, 20)
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x7cc8ff, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false,
  })
  const ring = new THREE.Mesh(ringGeo, ringMat)
  group.add(ring)

  group.position.copy(point.position)
  group.userData = { isInspectionPoint: true, pointId: point.id, index, core, ring }
  return group
}

/** 判断文本是否匹配某故障类型（用于关键词评分） */
export function matchFaultKeyword(text, colorType) {
  const t = String(text || '').trim()
  if (!t) return { matched: false }
  const def = FAULT_KEYWORDS[colorType]
  if (!def) return { matched: false }
  const hit = def.keywords.find((k) => t.includes(k))
  return { matched: Boolean(hit), keyword: hit ?? null, label: def.label }
}

export function matchFaultType(value, faultType) {
  const selected = String(value || '').trim()
  if (!selected || !FAULT_TYPES[faultType]) return { matched: false }
  return { matched: selected === faultType, label: FAULT_TYPES[faultType].label }
}
