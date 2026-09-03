/**
 * 极简 QR 码生成器（无第三方依赖）
 * ---------------------------------------------------------------------------
 * 仅实现本系统需要的能力：
 *   · Byte 模式（UTF-8）
 *   · 纠错级别 L
 *   · 版本 1 ~ 10（足以容纳局域网 URL）
 * 输出为「终端 ASCII 半块」或「SVG 字符串」。
 */

// ── Galois Field GF(256) ──
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
;(function initGF() {
  let x = 1
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]
})()

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

/** 生成生成多项式 */
function genPoly(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= gfMul(poly[j], 1)
      next[j + 1] ^= gfMul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

/** Reed-Solomon 纠错码 */
function rsEncode(data, ecCount) {
  const gen = genPoly(ecCount)
  const res = new Array(ecCount).fill(0)
  for (const byte of data) {
    const factor = byte ^ res[0]
    res.shift()
    res.push(0)
    for (let i = 0; i < ecCount; i += 1) res[i] ^= gfMul(gen[i + 1], factor)
  }
  return res
}

// ── 版本参数表（纠错级别 L）──
// 每项：[总码字, 每块数据码字, 块数(组1), 块数(组2), 组1块数据码字, 组2块数据码字]
const V_L = {
  1: [26, 19, 1, 0, 19, 0],
  2: [44, 34, 1, 0, 34, 0],
  3: [70, 55, 1, 0, 55, 0],
  4: [100, 80, 1, 0, 80, 0],
  5: [134, 108, 1, 0, 108, 0],
  6: [172, 136, 2, 0, 68, 0],
  7: [196, 156, 2, 0, 78, 0],
  8: [242, 194, 2, 0, 97, 0],
  9: [292, 232, 2, 0, 116, 0],
  10: [346, 274, 2, 2, 68, 69],
}

// 对齐图案中心坐标
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
}

function versionCapacity(v) {
  const spec = V_L[v]
  const ecTotal = spec[0] - spec[1]
  return { dataCodewords: spec[1], ecPerBlock: Math.floor(ecTotal / (spec[2] + spec[3])) }
}

function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v += 1) {
    const { dataCodewords } = versionCapacity(v)
    // byte 模式：4bit 模式 + 8bit 长度(版本1-9) 或 16bit(版本10+)
    const lenBits = v <= 9 ? 8 : 16
    const need = Math.ceil((4 + lenBits + byteLen * 8) / 8)
    if (need <= dataCodewords) return v
  }
  throw new Error('内容过长，超出本生成器支持范围')
}

/** 构造数据码字流 */
function buildCodewords(bytes, version) {
  const { dataCodewords, ecPerBlock } = versionCapacity(version)
  const spec = V_L[version]
  const bits = []
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((val >> i) & 1)
  }
  push(0b0100, 4) // byte mode
  push(bytes.length, version <= 9 ? 8 : 16)
  for (const b of bytes) push(b, 8)

  // 终止符
  const capBits = dataCodewords * 8
  for (let i = 0; i < 4 && bits.length < capBits; i += 1) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)
  // 填充
  const pads = [0xec, 0x11]
  let pi = 0
  while (bits.length < capBits) { push(pads[pi % 2], 8); pi += 1 }

  const data = []
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j += 1) b = (b << 1) | bits[i + j]
    data.push(b)
  }

  // 分块
  const g1Count = spec[2]
  const g2Count = spec[3]
  const g1Size = spec[4]
  const g2Size = spec[5]
  const blocks = []
  let offset = 0
  for (let i = 0; i < g1Count; i += 1) { blocks.push(data.slice(offset, offset + g1Size)); offset += g1Size }
  for (let i = 0; i < g2Count; i += 1) { blocks.push(data.slice(offset, offset + g2Size)); offset += g2Size }

  // 纠错 + 交错
  const ecBlocks = blocks.map((b) => rsEncode(b, ecPerBlock))
  const result = []
  const maxLen = Math.max(...blocks.map((b) => b.length))
  for (let i = 0; i < maxLen; i += 1) {
    for (const b of blocks) if (i < b.length) result.push(b[i])
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const e of ecBlocks) result.push(e[i])
  }
  return result
}

/** 构建矩阵（未加掩码） */
function buildMatrix(version, codewords) {
  const size = version * 4 + 17
  const m = Array.from({ length: size }, () => new Array(size).fill(null))

  const setFn = (r, c, v) => { if (r >= 0 && r < size && c >= 0 && c < size) m[r][c] = v }

  // Finder + separator
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const rr = r0 + r
        const cc = c0 + c
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
        let v
        if (r >= 0 && r <= 6 && (c === 0 || c === 6)) v = 1
        else if (c >= 0 && c <= 6 && (r === 0 || r === 6)) v = 1
        else if (r >= 2 && r <= 4 && c >= 2 && c <= 4) v = 1
        else v = 0
        m[rr][cc] = v
      }
    }
  }
  finder(0, 0)
  finder(0, size - 7)
  finder(size - 7, 0)

  // Timing
  for (let i = 8; i < size - 8; i += 1) {
    const v = i % 2 === 0 ? 1 : 0
    if (m[6][i] === null) m[6][i] = v
    if (m[i][6] === null) m[i][6] = v
  }

  // Alignment
  const coords = ALIGN[version]
  for (const r of coords) {
    for (const c of coords) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const v = (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0
          setFn(r + dr, c + dc, v)
        }
      }
    }
  }

  // Dark module
  m[size - 8][8] = 1

  // Format info 占位（后面填）
  const formatPositions = []
  for (let i = 0; i <= 8; i += 1) if (m[8][i] === null) formatPositions.push([8, i])
  for (let i = 0; i <= 8; i += 1) if (m[i][8] === null) formatPositions.push([i, 8])
  for (let i = 0; i < 8; i += 1) formatPositions.push([8, size - 1 - i])
  for (let i = 0; i < 8; i += 1) formatPositions.push([size - 1 - i, 8])

  // 数据放置
  let bitIndex = 0
  const total = codewords.length * 8
  const nextBit = () => {
    if (bitIndex >= total) return 0
    const byte = codewords[bitIndex >> 3]
    const bit = (byte >> (7 - (bitIndex & 7))) & 1
    bitIndex += 1
    return bit
  }

  let up = true
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1
    for (let i = 0; i < size; i += 1) {
      const row = up ? size - 1 - i : i
      for (let k = 0; k < 2; k += 1) {
        const c = col - k
        if (m[row][c] === null) m[row][c] = nextBit()
      }
    }
    up = !up
  }

  return { m, size, formatPositions }
}

/** 8 种掩码函数 */
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

function applyMask(m, size, maskId, isFn) {
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (isFn(r, c)) continue
      if (MASKS[maskId](r, c)) m[r][c] ^= 1
    }
  }
}

/** 计算惩罚分 */
function penalty(m, size) {
  let score = 0
  // 规则1：连续同色
  const scan = (get) => {
    let run = 1
    for (let i = 1; i < size; i += 1) {
      if (get(i) === get(i - 1)) { run += 1 } else {
        if (run >= 5) score += 3 + (run - 5)
        run = 1
      }
    }
    if (run >= 5) score += 3 + (run - 5)
  }
  for (let r = 0; r < size; r += 1) scan((i) => m[r][i])
  for (let c = 0; c < size; c += 1) scan((i) => m[i][c])

  // 规则2：2x2 同色块
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = m[r][c]
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3
    }
  }

  // 规则4：黑白比例
  let dark = 0
  for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) if (m[r][c] === 1) dark += 1
  const ratio = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10

  return score
}

function isFunctionModule(r, c, size, version) {
  if (r < 9 && c < 9) return true
  if (r < 9 && c >= size - 8) return true
  if (r >= size - 8 && c < 9) return true
  if (r === 6 || c === 6) return true
  const coords = ALIGN[version]
  for (const ar of coords) {
    for (const ac of coords) {
      if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true
    }
  }
  return false
}

function formatBits(ecLevel, maskId) {
  // EC level L = 01
  const data = (0b01 << 3) | maskId
  let d = data << 10
  const g = 0b10100110111
  for (let i = 14; i >= 10; i -= 1) {
    if ((d >> i) & 1) d ^= g << (i - 10)
  }
  return ((data << 10) | d) ^ 0b101010000010010
}

/** 生成 QR 矩阵（0/1 二维数组） */
export function generate(text) {
  const bytes = Array.from(Buffer.from(text, 'utf8'))
  const version = pickVersion(bytes.length)
  const codewords = buildCodewords(bytes, version)
  const size = version * 4 + 17

  let best = null
  for (let mask = 0; mask < 8; mask += 1) {
    const { m, formatPositions } = buildMatrix(version, codewords)
    applyMask(m, size, mask, (r, c) => isFunctionModule(r, c, size, version))
    // 写格式信息
    const fb = formatBits(1, mask) // EC L
    const fbBits = []
    for (let i = 14; i >= 0; i -= 1) fbBits.push((fb >> i) & 1)
    // 标准格式位置顺序
    const pos1 = []
    for (let i = 0; i <= 5; i += 1) pos1.push([8, i])
    pos1.push([8, 7]); pos1.push([8, 8]); pos1.push([7, 8])
    for (let i = 5; i >= 0; i -= 1) pos1.push([i, 8])
    const pos2 = []
    for (let i = 0; i < 7; i += 1) pos2.push([size - 1 - i, 8])
    for (let i = 0; i < 8; i += 1) pos2.push([8, size - 1 - i])
    const all = [...pos1, ...pos2]
    for (let i = 0; i < all.length && i < 15; i += 1) {
      const [r, c] = all[i]
      m[r][c] = fbBits[i]
    }
    void formatPositions

    const score = penalty(m, size)
    if (!best || score < best.score) best = { m, score, mask }
  }
  return { matrix: best.m, size, version }
}

/** 渲染为终端 ASCII（半块字符，每 2 行压 1 行） */
export function toTerminal(text, { invert = false } = {}) {
  const { matrix, size } = generate(text)
  const quiet = 2
  const total = size + quiet * 2
  const lines = []
  for (let r = -quiet; r < size + quiet; r += 2) {
    let line = ''
    for (let c = -quiet; c < total - quiet; c += 1) {
      const top = r >= 0 && r < size && c >= 0 && c < size ? matrix[r][c] === 1 : false
      const bottom = r + 1 >= 0 && r + 1 < size && c >= 0 && c < size ? matrix[r + 1][c] === 1 : false
      const t = invert ? !top : top
      const b = invert ? !bottom : bottom
      if (t && b) line += ' '
      else if (t && !b) line += '▀'
      else if (!t && b) line += '▄'
      else line += '█'
    }
    lines.push('  ' + line)
  }
  return lines.join('\n')
}

/** 渲染为 SVG 字符串 */
export function toSvg(text, { scale = 6, quiet = 2 } = {}) {
  const { matrix, size } = generate(text)
  const dim = (size + quiet * 2) * scale
  let rects = ''
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (matrix[r][c] === 1) {
        rects += `<rect x="${(c + quiet) * scale}" y="${(r + quiet) * scale}" width="${scale}" height="${scale}"/>`
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}"><rect width="${dim}" height="${dim}" fill="#fff"/><g fill="#000">${rects}</g></svg>`
}
