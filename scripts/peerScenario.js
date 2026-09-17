// V3 允许同一观测站位、同一语义零部件保存多处独立故障。
// 使用独立存储键，避免旧版按 pointId 覆盖保存的草稿污染新题目。
const STORAGE_KEY = 'hxd3d-peer-scenario-v3'
export const PEER_SCENARIO_VERSION = 3
export const PEER_MODEL_VERSION = 'hxd3d-integration-spatial-v1'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

export function createPeerScenario(author = {}) {
  return {
    version: PEER_SCENARIO_VERSION,
    modelVersion: PEER_MODEL_VERSION,
    scenarioId: `TC${Date.now().toString(36).toUpperCase()}`,
    status: 'draft',
    author: {
      name: String(author.name || '').trim(),
      id: String(author.id || '').trim(),
      group: String(author.group || '').trim(),
    },
    createdAt: new Date().toISOString(),
    lockedAt: '',
    faults: [],
  }
}

export function normalizePeerScenario(raw) {
  if (!raw || raw.version !== PEER_SCENARIO_VERSION || raw.modelVersion !== PEER_MODEL_VERSION) return null
  if (!Array.isArray(raw.faults)) return null
  return {
    ...clone(raw),
    status: raw.status === 'locked' ? 'locked' : 'draft',
    faults: raw.faults.filter((fault) => fault?.faultId && fault?.pointId && fault?.anchor?.position),
  }
}

export function loadPeerScenario() {
  try {
    return normalizePeerScenario(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'))
  } catch {
    return null
  }
}

export function savePeerScenario(scenario) {
  const normalized = normalizePeerScenario(scenario)
  if (!normalized) return null
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized)) } catch {}
  return normalized
}

export function clearPeerScenario() {
  try { localStorage.removeItem(STORAGE_KEY) } catch {}
}

export function allowedFaultTypes(point) {
  const configured = point?.part?.judge?.faults ?? point?.faults ?? []
  const types = configured.map((entry) => entry?.faultType).filter(Boolean)
  return [...new Set(types)]
}

export function firstFaultType(point) {
  return allowedFaultTypes(point)[0] ?? ''
}

export function nextFaultType(point, current) {
  const allowed = allowedFaultTypes(point)
  if (!allowed.length) return ''
  const index = Math.max(0, allowed.indexOf(current))
  return allowed[(index + 1) % allowed.length]
}

export function upsertScenarioFault(scenario, fault) {
  if (!scenario || scenario.status !== 'draft') return scenario
  const next = clone(scenario)
  const record = {
    ...clone(fault),
    faultId: fault.faultId || `F-${fault.pointId}`,
  }
  // faultId 是一枚物理故障的唯一标识。不能再按 pointId 覆盖，否则同一
  // 零部件或同一观测站位设置第二处故障时，第一处会静默消失。
  const index = next.faults.findIndex((item) => item.faultId === record.faultId)
  if (index >= 0) next.faults[index] = record
  else next.faults.push(record)
  return savePeerScenario(next)
}

export function updateScenarioFaultType(scenario, faultId, faultType) {
  if (!scenario || scenario.status !== 'draft') return scenario
  const next = clone(scenario)
  const fault = next.faults.find((item) => item.faultId === faultId)
  if (!fault) return scenario
  fault.faultType = faultType
  // 不同符号的顶点数量与轮廓不同，切换类型后必须按真实表面重新投影。
  if (fault.anchor) delete fault.anchor.vertices
  return savePeerScenario(next)
}

export function removeLastScenarioFault(scenario) {
  if (!scenario || scenario.status !== 'draft' || !scenario.faults.length) return scenario
  const next = clone(scenario)
  next.faults.pop()
  return savePeerScenario(next)
}

export function lockPeerScenario(scenario) {
  if (!scenario || scenario.status !== 'draft' || !scenario.faults.length) return null
  const next = clone(scenario)
  next.status = 'locked'
  next.lockedAt = new Date().toISOString()
  return savePeerScenario(next)
}
