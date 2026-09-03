/**
 * GLB 几何分析工具（开发期工具，运行时不加载）
 * ---------------------------------------------------------------------------
 * 用途：在不启动浏览器的情况下，解析 HXD3D 整合模型的 GLB 二进制，
 *       输出「节点名 / 世界变换 / 每个 mesh 的世界包围盒 / 三角形数」。
 *
 * 背景：走行部零部件检查要求为每个部件建立交互代理与碰撞代理，
 *       而原模型是合并网格（没有 wheel / axlebox 这类独立节点），
 *       因此必须先用真实几何数据确定轮对、轴箱、构架等的空间位置，
 *       不能凭经验猜测坐标。
 *
 * 用法：
 *   node tools/inspect-glb.mjs <path-to.glb> [--flat] [--min-tris=N]
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const GLB_MAGIC = 0x46546c67 // 'glTF'
const CHUNK_JSON = 0x4e4f534a // 'JSON'
const CHUNK_BIN = 0x004e4942 // 'BIN\0'

function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('不是合法的 GLB 文件（magic 不匹配）')
  const version = buf.readUInt32LE(4)
  const total = buf.readUInt32LE(8)
  let offset = 12
  let json = null
  let bin = null
  while (offset + 8 <= total) {
    const len = buf.readUInt32LE(offset)
    const type = buf.readUInt32LE(offset + 4)
    const start = offset + 8
    if (type === CHUNK_JSON) json = JSON.parse(buf.toString('utf8', start, start + len))
    else if (type === CHUNK_BIN) bin = buf.subarray(start, start + len)
    offset = start + len + ((4 - (len % 4)) % 4) // 4 字节对齐补齐
  }
  return { version, json, bin }
}

// ── 4x4 矩阵（列主序，与 glTF 一致） ──
const M4 = {
  identity: () => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  multiply(a, b) {
    const o = new Float64Array(16)
    for (let c = 0; c < 4; c += 1) {
      for (let r = 0; r < 4; r += 1) {
        let s = 0
        for (let k = 0; k < 4; k += 1) s += a[k * 4 + r] * b[c * 4 + k]
        o[c * 4 + r] = s
      }
    }
    return o
  },
  fromTRS(t, r, s) {
    const [x, y, z, w] = r ?? [0, 0, 0, 1]
    const [sx, sy, sz] = s ?? [1, 1, 1]
    const [tx, ty, tz] = t ?? [0, 0, 0]
    const x2 = x + x, y2 = y + y, z2 = z + z
    const xx = x * x2, xy = x * y2, xz = x * z2
    const yy = y * y2, yz = y * z2, zz = z * z2
    const wx = w * x2, wy = w * y2, wz = w * z2
    // 列主序：m[c*4+r]
    return new Float64Array([
      (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
      (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
      (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
      tx, ty, tz, 1,
    ])
  },
  fromArray(arr) { return new Float64Array(arr) }, // glTF matrix 已按列主序给出
  /** 变换包围盒的 8 个角点，返回变换后的 AABB */
  transformBox(m, box) {
    const [mnx, mny, mnz, mxx, mxy, mxz] = box
    let nx = Infinity, ny = Infinity, nz = Infinity
    let px = -Infinity, py = -Infinity, pz = -Infinity
    for (let i = 0; i < 8; i += 1) {
      const x = i & 1 ? mxx : mnx
      const y = i & 2 ? mxy : mny
      const z = i & 4 ? mxz : mnz
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12]
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13]
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14]
      if (wx < nx) nx = wx; if (wx > px) px = wx
      if (wy < ny) ny = wy; if (wy > py) py = wy
      if (wz < nz) nz = wz; if (wz > pz) pz = wz
    }
    return [nx, ny, nz, px, py, pz]
  },
}

function unionBox(a, b) {
  if (!a) return b ? b.slice() : null
  if (!b) return a
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]),
    Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5])]
}

/** 获取 mesh 的 POSITION accessor 包围盒（合并所有 primitive） */
function meshLocalBox(json, meshIndex) {
  const mesh = json.meshes?.[meshIndex]
  if (!mesh) return null
  let box = null
  let tris = 0
  for (const prim of mesh.primitives ?? []) {
    const acc = json.accessors?.[prim.attributes?.POSITION]
    if (!acc?.min || !acc?.max) continue
    box = unionBox(box, [...acc.min, ...acc.max])
    const idxCount = prim.indices != null ? json.accessors?.[prim.indices]?.count : acc.count
    tris += Math.floor((idxCount ?? 0) / 3)
  }
  return box ? { box, tris } : null
}

/** 读取 accessor 的 VEC3 float 数组（应用节点世界矩阵） */
function readVec3Positions(json, bin, accessorIndex) {
  const acc = json.accessors[accessorIndex]
  if (!acc || acc.componentType !== 5126 || acc.type !== 'VEC3') return null
  const bv = json.bufferViews[acc.bufferView]
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  const stride = bv.byteStride || 12
  const out = new Float64Array(acc.count * 3)
  for (let i = 0; i < acc.count; i += 1) {
    const o = base + i * stride
    out[i * 3] = bin.readFloatLE(o)
    out[i * 3 + 1] = bin.readFloatLE(o + 4)
    out[i * 3 + 2] = bin.readFloatLE(o + 8)
  }
  return { data: out, count: acc.count, min: acc.min, max: acc.max }
}

/**
 * 顶点空间探针 —— 合并网格没有独立部件节点时，用顶点密度反推部件位置
 * 输出：沿车长 X 的顶点分布峰值（轮对/转向架位置）、沿车高 Y 的分布（轨面/构架/底架）
 */
function probe(file, opts = {}) {
  const buf = readFileSync(file)
  const { json, bin } = parseGlb(buf)
  const targetNode = opts.node ?? 'Static_Main_Body'

  let nodeIdx = -1
  ;(json.nodes ?? []).forEach((n, i) => { if (n.name === targetNode && n.mesh != null) nodeIdx = i })
  if (nodeIdx < 0) throw new Error(`找不到带 mesh 的节点：${targetNode}`)

  // 节点世界矩阵（必须沿父链回溯：Static_Main_Body 挂在带旋转/平移的根节点下）
  const localMat = (i) => {
    const n = json.nodes[i]
    if (n.matrix) return M4.fromArray(n.matrix)
    if (n.translation || n.rotation || n.scale) return M4.fromTRS(n.translation, n.rotation, n.scale)
    return M4.identity()
  }
  const parentOf = new Array(json.nodes.length).fill(-1)
  ;(json.nodes ?? []).forEach((n, i) => { for (const c of n.children ?? []) parentOf[c] = i })
  const worldCache = new Array(json.nodes.length).fill(null)
  const worldOf = (i) => {
    if (worldCache[i]) return worldCache[i]
    const p = parentOf[i]
    const m = p >= 0 ? M4.multiply(worldOf(p), localMat(i)) : localMat(i)
    worldCache[i] = m
    return m
  }
  const world = worldOf(nodeIdx)

  // 聚合该 mesh 的全部 primitive（单一 mesh 常被拆成多个 primitive 分批存索引）
  const prims = json.meshes[json.nodes[nodeIdx].mesh].primitives
  const chunks = []
  let vertTotal = 0
  for (const p of prims) {
    const src = readVec3Positions(json, bin, p.attributes.POSITION)
    if (!src) continue
    chunks.push(src)
    vertTotal += src.count
  }
  if (!chunks.length) throw new Error('POSITION 不是 float VEC3，无法探针分析')

  const pts = new Float64Array(vertTotal * 3)
  let w = 0
  for (const src of chunks) {
    for (let i = 0; i < src.count; i += 1) {
      const x = src.data[i * 3], y = src.data[i * 3 + 1], z = src.data[i * 3 + 2]
      pts[w * 3] = world[0] * x + world[4] * y + world[8] * z + world[12]
      pts[w * 3 + 1] = world[1] * x + world[5] * y + world[9] * z + world[13]
      pts[w * 3 + 2] = world[2] * x + world[6] * y + world[10] * z + world[14]
      w += 1
    }
  }
  const src = { count: vertTotal }

  let yMin = Infinity, yMax = -Infinity, zMin = Infinity, zMax = -Infinity
  for (let i = 0; i < src.count; i += 1) {
    const y = pts[i * 3 + 1], z = pts[i * 3 + 2]
    if (y < yMin) yMin = y; if (y > yMax) yMax = y
    if (z < zMin) zMin = z; if (z > zMax) zMax = z
  }

  // ── Y 方向直方图：找轨面 / 轮心 / 构架 / 底架 ──
  const yBin = 0.05
  const yHist = new Map()
  for (let i = 0; i < src.count; i += 1) {
    const k = Math.round((pts[i * 3 + 1] - yMin) / yBin)
    yHist.set(k, (yHist.get(k) ?? 0) + 1)
  }

  // ── X 方向直方图（限定走行部高度带）：找轮对 / 转向架 ──
  const bandLo = opts.bandLo ?? yMin
  const bandHi = opts.bandHi ?? yMin + 1.5
  const xBin = 0.1
  const xHist = new Map()
  const zBin = 0.05
  const zHist = new Map()
  for (let i = 0; i < src.count; i += 1) {
    const y = pts[i * 3 + 1]
    if (y < bandLo || y > bandHi) continue
    const k = Math.round(pts[i * 3] / xBin)
    xHist.set(k, (xHist.get(k) ?? 0) + 1)
    const kz = Math.round(pts[i * 3 + 2] / zBin)
    zHist.set(kz, (zHist.get(kz) ?? 0) + 1)
  }

  return {
    vertexCount: src.count, yMin, yMax, zMin, zMax,
    yHist: [...yHist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => ({ y: yMin + k * yBin, n: v })),
    xHist: [...xHist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => ({ x: k * xBin, n: v })),
    zHist: [...zHist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => ({ z: k * zBin, n: v })),
  }
}

function analyze(file, opts = {}) {
  const buf = readFileSync(file)
  const { json, version } = parseGlb(buf)
  const minTris = opts.minTris ?? 0

  // 逐节点计算世界矩阵
  const nodeWorld = new Array(json.nodes?.length ?? 0).fill(null)
  const nodeParent = new Array(json.nodes?.length ?? 0).fill(-1)
  ;(json.scenes?.[json.scene ?? 0]?.nodes ?? []).forEach((n) => { nodeParent[n] = -2 })
  // 建立父子关系（DFS）
  const stack = [...(json.scenes?.[json.scene ?? 0]?.nodes ?? [])]
  while (stack.length) {
    const i = stack.pop()
    for (const c of json.nodes?.[i]?.children ?? []) { nodeParent[c] = i; stack.push(c) }
  }
  const localMat = (i) => {
    const n = json.nodes[i]
    if (!n) return M4.identity()
    if (n.matrix) return M4.fromArray(n.matrix)
    if (n.translation || n.rotation || n.scale) return M4.fromTRS(n.translation, n.rotation, n.scale)
    return M4.identity()
  }
  const worldOf = (i) => {
    if (nodeWorld[i]) return nodeWorld[i]
    const p = nodeParent[i]
    const world = p >= 0 ? M4.multiply(worldOf(p), localMat(i)) : localMat(i)
    nodeWorld[i] = world
    return world
  }

  const rows = []
  let total = null
  let totalTris = 0
  ;(json.nodes ?? []).forEach((n, i) => {
    if (n.mesh == null) return
    const local = meshLocalBox(json, n.mesh)
    if (!local) return
    const world = worldOf(i)
    const wbox = M4.transformBox(world, local.box)
    total = unionBox(total, wbox)
    totalTris += local.tris
    if (local.tris < minTris) return
    rows.push({
      node: n.name ?? `#${i}`,
      mesh: json.meshes?.[n.mesh]?.name ?? '',
      tris: local.tris,
      min: wbox.slice(0, 3),
      max: wbox.slice(3, 6),
      center: [(wbox[0] + wbox[3]) / 2, (wbox[1] + wbox[4]) / 2, (wbox[2] + wbox[5]) / 2],
      size: [wbox[3] - wbox[0], wbox[4] - wbox[1], wbox[5] - wbox[2]],
    })
  })

  return { version, total, totalTris, rows, nodeCount: json.nodes?.length ?? 0, meshCount: json.meshes?.length ?? 0 }
}

// ── CLI ──
const file = process.argv[2]
if (!file) {
  console.error('用法: node tools/inspect-glb.mjs <file.glb> [--min-tris=N] [--sort=x|y|z|tris]')
  process.exit(1)
}
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`))
  return hit ? Number(hit.split('=')[1]) : d
}
const argStr = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.split('=')[1] : d
}
const sortKey = (process.argv.find((a) => a.startsWith('--sort=')) || '--sort=x').split('=')[1]

// ── 探针模式：顶点密度反推部件位置 ──
if (process.argv.includes('--probe')) {
  const r = probe(file, {
    node: argStr('node', 'Static_Main_Body'),
    bandLo: arg('band-lo', NaN),
    bandHi: arg('band-hi', NaN),
  })
  const railY = r.yMin
  console.log(`\n顶点探针 · ${argStr('node', 'Static_Main_Body')}`)
  console.log(`顶点数 ${r.vertexCount.toLocaleString()} · y∈[${railY.toFixed(3)}, ${r.yMax.toFixed(3)}] · z∈[${r.zMin.toFixed(3)}, ${r.zMax.toFixed(3)}]`)

  console.log(`\n【沿车高 Y 的顶点分布】(bin=0.05m，相对轨面高度)`)
  const yMaxN = Math.max(...r.yHist.map((h) => h.n))
  r.yHist.filter((h) => h.y - railY < 3.2).forEach((h) => {
    const bar = '█'.repeat(Math.round((h.n / yMaxN) * 46))
    console.log(`  h=${(h.y - railY).toFixed(2).padStart(5)}m ${String(h.n).padStart(7)} ${bar}`)
  })

  console.log(`\n【走行部高度带内沿车长 X 的顶点分布】(bin=0.10m)`)
  const xMaxN = Math.max(...r.xHist.map((h) => h.n))
  r.xHist.forEach((h) => {
    const bar = '█'.repeat(Math.round((h.n / xMaxN) * 40))
    console.log(`  x=${h.x.toFixed(1).padStart(7)} ${String(h.n).padStart(7)} ${bar}`)
  })

  // ── 横向 Z 分布：判定左右侧轮轨面、转向架侧梁、车体侧墙 ──
  const zc = (r.zMin + r.zMax) / 2
  console.log(`\n【走行部高度带内沿车宽 Z 的顶点分布】(bin=0.05m，相对轨道中心)`)
  const zMaxN = Math.max(...r.zHist.map((h) => h.n))
  r.zHist.forEach((h) => {
    const bar = '█'.repeat(Math.round((h.n / zMaxN) * 34))
    console.log(`  Δz=${(h.z - zc).toFixed(2).padStart(6)}m ${String(h.n).padStart(7)} ${bar}`)
  })

  // 自动识别轮对峰值：连续高密度区间
  const xs = r.xHist
  const thresh = xMaxN * 0.35
  const groups = []
  let cur = null
  for (const h of xs) {
    if (h.n >= thresh) { if (!cur) cur = { from: h.x, to: h.x, peak: 0 }; cur.to = h.x; cur.peak = Math.max(cur.peak, h.n) }
    else if (cur) { groups.push(cur); cur = null }
  }
  if (cur) groups.push(cur)
  console.log(`\n【自动识别的高密度区间】(阈值 ${Math.round(thresh)})`)
  groups.forEach((g) => {
    console.log(`  x∈[${g.from.toFixed(1)}, ${g.to.toFixed(1)}]  中心 ${((g.from + g.to) / 2).toFixed(2)}  宽度 ${(g.to - g.from).toFixed(1)}  峰值 ${g.peak}`)
  })
  console.log('')
  process.exit(0)
}

const { total, totalTris, rows, nodeCount, meshCount } = analyze(file, { minTris: arg('min-tris', 0) })
const f = (n) => Number(n).toFixed(3).padStart(9)

console.log(`\n文件: ${basename(file)}`)
console.log(`节点 ${nodeCount} · Mesh ${meshCount} · 三角形 ${totalTris.toLocaleString()}`)
console.log(`\n整车世界包围盒:`)
console.log(`  min  x=${f(total[0])}  y=${f(total[1])}  z=${f(total[2])}`)
console.log(`  max  x=${f(total[3])}  y=${f(total[4])}  z=${f(total[5])}`)
console.log(`  size x=${f(total[3] - total[0])}  y=${f(total[4] - total[1])}  z=${f(total[5] - total[2])}`)

const srt = { x: (r) => r.min[0], y: (r) => r.min[1], z: (r) => r.min[2], tris: (r) => -r.tris }[sortKey] ?? ((r) => r.min[0])
rows.sort((a, b) => srt(a) - srt(b))

console.log(`\nMesh 明细（${rows.length} 条，按 ${sortKey} 排序）:`)
console.log('  ' + '节点名'.padEnd(34) + '三角形'.padStart(10) + '   center(x,y,z)'.padEnd(42) + 'size(x,y,z)')
rows.forEach((r) => {
  console.log('  ' + r.node.slice(0, 32).padEnd(34)
    + String(r.tris).padStart(10)
    + `   [${r.center.map((v) => v.toFixed(2).padStart(7)).join(',')}]`
    + ` [${r.size.map((v) => v.toFixed(2).padStart(6)).join(',')}]`)
})
console.log('')
