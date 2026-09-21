/**
 * 机车检查作业系统 V3 —— 主交互
 * ---------------------------------------------------------------------------
 * 三种模式：
 *   scene   场景：OrbitControls 观察整车 + 部位定位 + 检查项勾选
 *   roam    漫游：人视角走动（碰撞/跳跃/下蹲），靠近检查点按 E 交互
 *   inspect 检视：相机聚焦放大检查点，旋转视角找故障标记 → 填报故障活件
 *
 * 移动端：固定方向摇杆 + 独立按键（交互/提交/加速/跳跃/下蹲）
 * 原孪生平台模型：只读不改不裁剪，检查内容以"检查点 + 故障标记"叠加
 */
import {
  INSPECTION_META,
  INSPECTION_ROUTES as ALL_INSPECTION_ROUTES,
  METHOD_LABELS,
  LEVEL_LABELS,
} from './inspectionData.js?v=1.8.3'
import { createInspectionScene } from './sceneController.js?v=1.8.3'
import { FAULT_TYPES } from './partInspection.js'
import { getRunningGearItemIds, getRunningGearParts } from './parts/runningGearParts.js'
import { createInspectionFlow } from './inspectionFlow.js'
import { computeScore } from './scoring.js?v=1.8.3'
import {
  createPeerScenario,
  loadPeerScenario,
  savePeerScenario,
  allowedFaultTypes,
  firstFaultType,
  nextFaultType,
  upsertScenarioFault,
  updateScenarioFaultType,
  removeLastScenarioFault,
  lockPeerScenario,
  markPeerScenarioAnswering,
  finishPeerScenario,
} from './peerScenario.js?v=1.8.3'

const STORAGE_PREFIX = 'hxd3d-inspection-session-v3'
const PROFILE_KEY = 'hxd3d-inspection-last-profile-v1'
/** 当前开放的车外检查项目合计约 26 分钟，按 30 分钟作为一轮训练时限。 */
const SESSION_LIMIT_SECONDS = 30 * 60
const RING_LENGTH = 125.6
/** 当前只开放可在车外完成的检查：走行部、车钩连接、端部外观与信号。 */
const ACTIVE_ROUTE_IDS = new Set(['roof', 'bogie', 'coupler', 'signal'])
const INSPECTION_ROUTES = ALL_INSPECTION_ROUTES.filter((route) => ACTIVE_ROUTE_IDS.has(route.id))
const TOTAL_ITEM_COUNT = INSPECTION_ROUTES.reduce((sum, route) => sum + route.items.length, 0)

const $ = (id) => document.getElementById(id)
const itemIndex = new Map()
let itemSerial = 0
INSPECTION_ROUTES.forEach((route) => route.items.forEach((item) => {
  itemSerial += 1
  itemIndex.set(item.id, { serial: itemSerial, route, item })
}))
/** 走行部检查项集合（这些检查项由零部件配置驱动，右侧卡片点击只定位不进入） */
const RUNNING_GEAR_ITEM_IDS = new Set(getRunningGearItemIds())

let state = {
  sessionId: '',
  operator: '教学演练',
  profile: { name: '', id: '', group: '', device: '', mode: 'author' },
  startTime: '',
  items: {}, // itemId -> { status, note, action, level, time, faultsFound, faultsTotal }
}
let currentRouteIndex = 0
let scene = null
let expandedAll = false
let modelSourceLabel = '加载中'
let activePoint = null       // 当前检视的检查点
let pendingMarker = null     // 待判定的故障标记
let pendingPoint = null      // 待填报标记所属的具体语义零部件（可不同于当前标准站位）
let authorTargetPoint = null // 出题工具栏当前对应的具体零部件
let preInspectMode = 'scene' // 进入检视前的模式（退出时返回）
let contextItemId = null     // 漫游中当前靠近/正在检视的部件，只在右侧展示它的要点
let sessionTimer = null
let landscapeRequest = null
let roamHintShown = false
let trainingChromeTimer = null
let peerScenario = loadPeerScenario()
let authorFaultType = 'crack'
let pendingExpectedReport = null

// 活件名称采用“部件语义 + 专业同义名”判断，不用泛化的字符串相似度。
// 后者会把“车钩”“钩提销”“车钩高度”等不同检查对象错误地判为相同。
const PART_TYPE_REPORT_ALIASES = Object.freeze({
  wheelset: ['轮对', '轮对踏面', '踏面', '轮缘'],
  axlebox: ['轴箱', '轴箱端盖', '轴箱盖'],
  primarySpring: ['一系悬挂', '一系弹簧', '一系弹性悬挂'],
  brakeDisc: ['制动盘', '闸盘'],
  brakeUnit: ['基础制动', '基础制动装置', '制动夹钳'],
  damper: ['油压减振器', '油压减震器', '减振器', '减震器'],
  tractionRod: ['横向拉杆', '牵引拉杆'],
  secondarySpring: ['二系悬挂', '二系弹簧'],
  motorGearbox: ['牵引电机', '齿轮箱', '牵引电机与齿轮箱'],
  sandBox: ['撒砂器', '沙箱', '撒砂装置', '侧面沙箱'],
  pilot: ['排障器', '排障器与脚踏', '脚踏'],
  undercar: ['车下管路', '风管', '管路与防滑件'],
})
const ITEM_REPORT_ALIASES = Object.freeze({
  'coupler-1': ['车钩钩体与钩舌', '车钩', '钩体', '钩舌'],
  'coupler-2': ['钩提销与提钩装置', '钩提销', '提钩装置', '钩锁销'],
  'coupler-3': ['缓冲器与从板座', '缓冲器', '从板座', '钩尾框'],
  'coupler-4': ['车钩高度测量', '车钩高度', '钩高'],
  'coupler-5': ['制动软管与折角塞门', '制动软管', '风管', '折角塞门'],
  'coupler-6': ['电源插座与重联连接器', '电源插座', '重联连接器', '重联插座'],
  'signal-1': ['前照灯与标志灯', '前照灯', '前灯', '标志灯'],
  'signal-5': ['前挡风玻璃与密封胶条', '前挡风玻璃', '挡风玻璃', '密封胶条'],
  'signal-6': ['端部刷箱', '刷箱'],
  'signal-7': ['和谐标志与车号', '和谐标志', '和谐', '车号'],
})

// 检查流程显式状态机（skill 约束 1）：阶段推进 + 完成判定
const flow = createInspectionFlow(INSPECTION_ROUTES, {
  isItemJudged: (id) => state.items[id]?.status ?? null,
})

// ───────────────────────── 存档 ─────────────────────────
function loadState() {
  try {
    const profile = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null')
    if (profile?.id) {
      state.profile = { ...state.profile, ...profile }
      state.operator = profile.name || state.operator
    }
    const userKey = encodeURIComponent(state.profile?.id || 'guest')
    const sessionId = localStorage.getItem(`${STORAGE_PREFIX}:latest:${userKey}`)
    const raw = sessionId ? localStorage.getItem(`${STORAGE_PREFIX}:${userKey}:${sessionId}`) : null
    if (!raw) return false
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.items === 'object') { state = { ...state, ...parsed }; return true }
  } catch {}
  return false
}
function saveState() {
  try {
    const profile = state.profile ?? {}
    const userKey = encodeURIComponent(profile.id || 'guest')
    localStorage.setItem(`${STORAGE_PREFIX}:${userKey}:${state.sessionId}`, JSON.stringify(state))
    localStorage.setItem(`${STORAGE_PREFIX}:latest:${userKey}`, state.sessionId)
    if (profile.id) localStorage.setItem(PROFILE_KEY, JSON.stringify(profile))
  } catch {}
}
function resetState() {
  state = {
    sessionId: `JC${Date.now().toString().slice(-8)}`,
    operator: state.operator,
    profile: state.profile ?? { name: '', id: '', group: '', device: '', mode: 'author' },
    startTime: formatNow(),
    deadlineAt: Date.now() + SESSION_LIMIT_SECONDS * 1000,
    finishedAt: '',
    finishReason: '',
    items: {},
  }
  saveState()
}
function formatNow() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ───────────────────────── 统计 ─────────────────────────
function routeStats(route) {
  let ok = 0, ng = 0
  route.items.forEach((i) => {
    const r = state.items[i.id]
    if (r?.status === 'ok') ok += 1
    else if (r?.status === 'ng') ng += 1
  })
  return { ok, ng, total: route.items.length, done: ok + ng }
}
function globalStats() {
  let ok = 0, ng = 0
  INSPECTION_ROUTES.forEach((r) => { const s = routeStats(r); ok += s.ok; ng += s.ng })
  return { ok, ng, total: TOTAL_ITEM_COUNT, done: ok + ng }
}
/** 故障检视评分：已发现标记 / 总标记 */
function faultStats() {
  const scenario = scene?.getFaultStats?.()
  if (scenario?.total) return { ...scenario, rate: scenario.found / scenario.total }
  let found = 0, total = 0
  INSPECTION_ROUTES.forEach((r) => {
    r.items.forEach((i) => {
      const rec = state.items[i.id]
      if (rec?.faultsTotal) { found += rec.faultsFound ?? 0; total += rec.faultsTotal }
    })
  })
  return { found, total, rate: total ? found / total : 0 }
}

function formatRemaining(seconds) {
  const s = Math.max(0, Math.ceil(seconds))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function updateSessionTimer() {
  if (!state.deadlineAt) state.deadlineAt = Date.now() + SESSION_LIMIT_SECONDS * 1000
  const remaining = Math.max(0, (state.deadlineAt - Date.now()) / 1000)
  $('foot-timer').textContent = formatRemaining(remaining)
  if (remaining <= 0 && !state.finishedAt) finishTraining('训练时间已到')
}

function finishTraining(reason) {
  if (state.finishedAt) return
  state.finishedAt = formatNow()
  state.finishReason = reason
  if (state.profile?.mode === 'peer') peerScenario = finishPeerScenario(peerScenario) ?? peerScenario
  saveState()
  updatePeerSubmitButton()
  if (scene?.getMode?.() === 'inspect') exitInspect()
  renderReport({ final: true })
}

function maybeFinishTraining() {
  const g = globalStats()
  if (g.done !== g.total || state.finishedAt) return
  // 同伴答题由学生主动点击“提交”后统一与出题故障比对，避免最后一个
  // 零部件确认时突然弹出成绩单；倒计时到期仍由计时器自动结算。
  if (state.profile?.mode === 'peer') {
    showToast('全部检查项目已完成，请点击右侧“提交”结算成绩')
    return
  }
  finishTraining('全部检查项目已完成')
}

// ───────────────────────── 渲染：左侧流程 ─────────────────────────
function renderRouteList() {
  const c = $('route-list')
  c.innerHTML = ''
  const current = flow.getCurrent()
  INSPECTION_ROUTES.forEach((route, i) => {
    const s = routeStats(route)
    const st = flow.stageOf(i)
    const unlocked = flow.canEnter(i)
    const b = document.createElement('button')
    b.className = 'route-item'
    if (i === current) b.classList.add('active')
    if (s.done === s.total) b.classList.add('done')
    if (!unlocked && i > current) b.classList.add('locked')
    b.innerHTML = `
      <span class="route-index">${String(i + 1).padStart(2, '0')}</span>
      <span class="route-text">
        <strong>${route.shortName}</strong>
        <small>${route.zone} · ${route.side}</small>
      </span>
      <span class="route-flag">
        <span class="route-count">${s.done}/${s.total}</span>
        ${s.ng > 0 ? `<span class="route-badge issue">异常 ${s.ng}</span>`
          : s.done === s.total ? '<span class="route-badge done">完成</span>'
          : i === current ? '<span class="route-badge current">检查中</span>'
          : '<span class="route-badge">待检</span>'}
      </span>`
    b.addEventListener('click', () => selectRoute(i, { focus: true }))
    c.appendChild(b)
  })
  const finished = INSPECTION_ROUTES.filter((r) => routeStats(r).done === r.items.length).length
  $('route-progress').textContent = `${finished} / ${INSPECTION_ROUTES.length}`
}

// ───────────────────────── 渲染：右侧检查项 ─────────────────────────
function renderRouteDetail() {
  const contextMeta = contextItemId ? itemIndex.get(contextItemId) : null
  const route = contextMeta?.route ?? INSPECTION_ROUTES[currentRouteIndex]
  const contextItem = contextMeta?.item ?? null
  const s = routeStats(route)
  $('item-panel-title').textContent = contextItem ? `当前部件 · ${contextItem.name}` : '当前检查部件'
  $('route-intro').innerHTML = contextItem ? `
    <strong>${contextItem.name}</strong>
    <p>${route.shortName} · ${route.zone}。以下仅显示该部件对应的检查要点。</p>
    <div class="zone-line">
      <em>${route.side}</em><em>${(contextItem.methods ?? []).map((m) => METHOD_LABELS[m] ?? m).join(' · ')}</em>
    </div>` : `
    <strong>等待选择检查部件</strong>
    <p>靠近机车上带光点的部件，右侧会自动显示该部件的检查要点、合格标准和风险提示。</p>
    <div class="zone-line"><em>${route.shortName}</em><em>已检 ${s.done}/${s.total}</em></div>`
  if (contextItem && route.safety?.length) {
    $('route-safety').style.display = 'grid'
    $('safety-list').innerHTML = route.safety.map((t) => `<li>${t}</li>`).join('')
  } else $('route-safety').style.display = 'none'

  const list = $('item-list')
  list.innerHTML = ''
  if (contextItem) list.appendChild(buildItemCard(contextItem, route))
  $('toggle-all').disabled = !contextItem
  $('toggle-all').textContent = contextItem ? (expandedAll ? '全部收起' : '全部展开') : '等待部件'
}

function setContextItem(itemId) {
  const nextId = itemIndex.has(itemId) ? itemId : null
  if (contextItemId === nextId) return
  contextItemId = nextId
  $('app').classList.toggle('has-active-inspection', Boolean(nextId))
  expandedAll = Boolean(nextId)
  renderRouteDetail()
}

function buildItemCard(item, route) {
  const record = state.items[item.id]
  const meta = itemIndex.get(item.id)
  const card = document.createElement('article')
  card.className = 'item-card'
  if (record?.status === 'ok') card.classList.add('ok')
  if (record?.status === 'ng') card.classList.add('ng')
  if (expandedAll) card.classList.add('open')

  const methodTags = (item.methods ?? []).map((m) => `<em>${METHOD_LABELS[m] ?? m}</em>`).join('')
  const levelTag = `<em class="level-${item.level}">${LEVEL_LABELS[item.level]?.text ?? ''}</em>`
  const hasPoint = Boolean(item.fault?.region)
  const pointBadge = hasPoint ? '<em style="color:#5cff9c;background:rgba(20,90,68,.5)">可3D检视</em>' : ''
  const foundTag = record?.faultsTotal ? `<em style="color:#5cff9c;background:rgba(20,90,68,.5)">故障 ${record.faultsFound ?? 0}/${record.faultsTotal}</em>` : ''

  card.innerHTML = `
    <div class="item-head">
      <span class="item-serial">${meta.serial}</span>
      <div>
        <div class="item-name">${item.name}</div>
        <div class="item-tags">${levelTag}${methodTags}${pointBadge}${foundTag}</div>
      </div>
      <span class="item-toggle">${expandedAll ? '收起 ▴' : '展开 ▾'}</span>
    </div>
    <div class="item-body">
      <div class="item-block"><h5>检查要点</h5><ul>${item.points.map((p) => `<li>${p}</li>`).join('')}</ul></div>
      <div class="item-block"><h5>合格标准</h5><div class="item-standard">${item.standard}</div></div>
      <div class="item-block">
        <h5>风险提示</h5>
        <div class="item-risk"><b>${LEVEL_LABELS[item.level]?.hint ?? ''}</b><span>${item.risk}</span></div>
      </div>
      <div class="issue-editor">
        <label>异常现象描述</label>
        <textarea rows="2" data-field="note" placeholder="例：轴箱端盖渗油，油迹长约 40 mm">${escapeHtml(record?.note ?? '')}</textarea>
        <div class="issue-row">
          <div><label>处置方式</label><select data-field="action">
            ${['', '现场处理', '报修临修', '扣车检修', '监护运行', '已上报调度']
              .map((o) => `<option value="${o}" ${record?.action === o ? 'selected' : ''}>${o || '请选择'}</option>`).join('')}
          </select></div>
          <div><label>处置时限</label><select data-field="level">
            ${['', '立即处理', '本次入库前', '本次交路内', '纳入临修计划']
              .map((o) => `<option value="${o}" ${record?.level === o ? 'selected' : ''}>${o || '请选择'}</option>`).join('')}
          </select></div>
        </div>
      </div>
      <div class="item-actions">
        <button class="act-btn pass ${record?.status === 'ok' ? 'active' : ''}" data-act="ok">✓ 合格</button>
        <button class="act-btn fail ${record?.status === 'ng' ? 'active' : ''}" data-act="ng">! 异常</button>
        ${hasPoint ? '<button class="act-btn" data-act="inspect">🔍 3D检视</button>' : ''}
        <button class="act-btn" data-act="clear">清除</button>
      </div>
    </div>`

  const head = card.querySelector('.item-head')
  const toggleText = card.querySelector('.item-toggle')
  head.addEventListener('click', () => {
    card.classList.toggle('open')
    toggleText.textContent = card.classList.contains('open') ? '收起 ▴' : '展开 ▾'
  })
  card.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const act = btn.dataset.act
      if (act === 'inspect') startInspection(item, route)
      else applyItemResult(item, act, card)
    })
  })
  card.querySelectorAll('[data-field]').forEach((f) => {
    const handler = () => {
      const r = state.items[item.id]
      if (!r) return
      r[f.dataset.field] = f.value
      r.time = formatNow()
      saveState()
    }
    f.addEventListener('input', handler)
    f.addEventListener('change', handler)
  })
  return card
}

function escapeHtml(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function applyItemResult(item, action, card) {
  if (action === 'clear') delete state.items[item.id]
  else {
    const previous = state.items[item.id] ?? {}
    const points = scorePointsForItem(item.id)
    if (points.length) {
      const partRecords = { ...(previous.partRecords ?? {}) }
      points.forEach((point) => {
        const before = partRecords[point.id] ?? {}
        const keepReportedFault = action === 'ok' && (before.status === 'ng' || Number(before.faultsFound ?? 0) > 0)
        partRecords[point.id] = {
          ...before,
          status: keepReportedFault ? 'ng' : action,
          faultsTotal: point.faultTotal,
          faultsFound: Number(before.faultsFound ?? 0),
          time: formatNow(),
        }
      })
      const records = Object.values(partRecords)
      state.items[item.id] = {
        ...previous,
        status: records.some((record) => record.status === 'ng') ? 'ng' : action,
        partRecords,
        faultsTotal: records.reduce((sum, record) => sum + Number(record.faultsTotal ?? 0), 0),
        faultsFound: records.reduce((sum, record) => sum + Number(record.faultsFound ?? 0), 0),
        time: formatNow(),
      }
    } else {
      state.items[item.id] = { ...previous, status: action, time: formatNow() }
    }
    if (action === 'ng' && card && !card.classList.contains('open')) {
      card.classList.add('open')
      const t = card.querySelector('.item-toggle')
      if (t) t.textContent = '收起 ▴'
    }
  }
  saveState()
  // 走行部零部件：把合格/异常同步进 FSM 运行时（用于 8 步状态机判定闭环）
  if (action === 'ok' || action === 'ng') {
    const fsm = scene?.getPartFSM?.()
    if (fsm) getRunningGearParts().filter((p) => p.itemId === item.id)
      .forEach((p) => fsm.judge(p.partId, { status: action }))
  }
  if (card) {
    card.classList.remove('ok', 'ng')
    const r = state.items[item.id]
    if (r?.status === 'ok') card.classList.add('ok')
    if (r?.status === 'ng') card.classList.add('ng')
    card.querySelectorAll('[data-act]').forEach((b) => {
      if (b.dataset.act === 'ok' || b.dataset.act === 'ng') b.classList.toggle('active', b.dataset.act === r?.status)
    })
  }
  refreshProgress()
  renderRouteList()
  showToast(action === 'ok' ? `已确认合格：${item.name}`
    : action === 'ng' ? `已登记异常：${item.name}` : `已清除记录：${item.name}`)
  if (action === 'ok' || action === 'ng') maybeFinishTraining()
}

// ───────────────────────── 进度 ─────────────────────────
function refreshProgress() {
  const g = globalStats()
  const f = faultStats()
  const ratio = g.total ? g.done / g.total : 0
  $('ring-fg').setAttribute('stroke-dashoffset', String(RING_LENGTH * (1 - ratio)))
  $('ring-text').textContent = `${Math.round(ratio * 100)}%`
  $('progress-stage').textContent = g.done === g.total ? '检查完成' : '检查进行中'
  $('progress-detail').textContent =
    `已检 ${g.done}/${g.total} · 合格 ${g.ok} · 异常 ${g.ng}` + (f.total ? ` · 故障 ${f.found}/${f.total}` : '')
  $('foot-done').textContent = `${g.done} / ${g.total}`
  $('foot-issue').textContent = String(g.ng)
  $('foot-fault').textContent = f.total ? `${f.found}/${f.total}` : '—'
  $('foot-operator').textContent = state.operator
  $('foot-time').textContent = state.startTime || '—'
  $('foot-model').textContent = modelSourceLabel
  const profile = state.profile ?? {}
  const footerMode = profile.mode === 'assessment' ? '考评模式'
    : profile.mode === 'author' ? '同伴出题'
      : profile.mode === 'peer' ? '同伴答题' : '练习模式'
  $('footer-session').title = `${profile.name || state.operator} · ${profile.id || '未登记'} · ${profile.group || '未填写班级'} · ${footerMode}`
}
function pointTotalForItem(itemId) {
  const points = scene?.getInspectionPoints?.() ?? []
  return points.filter((p) => (p.itemId ?? p.item?.id) === itemId && !p.isRouteEntry).length || 1
}

function semanticPointsIn(point = activePoint) {
  if (!point) return []
  return point.isStationPoint ? (point.stationParts ?? []) : [point]
}

function markersIn(point = activePoint) {
  return scene?.getMarkersForPoint?.(point)
    ?? semanticPointsIn(point).flatMap((candidate) => candidate.markers ?? [])
}
function faultTotalForItem(itemId) {
  const points = scene?.getInspectionPoints?.() ?? []
  return points.filter((p) => (p.itemId ?? p.item?.id) === itemId)
    .reduce((sum, p) => sum + (p.markers?.length ?? 0), 0)
}

function scorePointsForItem(itemId) {
  const points = scene?.getInspectionPoints?.() ?? []
  return points
    .filter((point) => !point.isRouteEntry && (point.itemId ?? point.item?.id) === itemId)
    .map((point) => ({ id: point.id, faultTotal: point.markers?.length ?? 0 }))
}

// ───────────────────────── 导航 ─────────────────────────
function selectRoute(index, { focus = true } = {}) {
  if (index < 0 || index >= INSPECTION_ROUTES.length) return
  // 状态机控制：越级（前面阶段未完成）只给提示，不跳转；已完成/当前可进入
  const res = flow.goTo(index)
  if (!res.ok) {
    showToast(res.reason)
    renderRouteList()
    return
  }
  currentRouteIndex = flow.getCurrent()
  contextItemId = null
  const route = INSPECTION_ROUTES[currentRouteIndex]
  renderRouteList()
  renderRouteDetail()
  if (focus) { scene?.focusRoute(route); showFocusHint(route) }
  refreshProgress()
}
function showFocusHint(route) {
  const h = $('focus-hint')
  h.style.display = 'block'
  h.textContent = `当前部位：${route.shortName} · ${route.zone}`
  clearTimeout(showFocusHint.timer)
  showFocusHint.timer = setTimeout(() => { h.style.display = 'none' }, 4200)
}

// ───────────────────────── Toast ─────────────────────────
let toastTimer
function showToast(msg) {
  let t = document.querySelector('.system-toast')
  if (!t) { t = document.createElement('div'); t.className = 'system-toast'; $('app').appendChild(t) }
  t.textContent = msg
  t.style.display = 'block'
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.style.display = 'none' }, 2400)
}

// ───────────────────────── 模式 ─────────────────────────
function setMode(mode) {
  const app = $('app')
  // 记录进入检视前的模式（用于退出时返回）
  const prevMode = app.classList.contains('mode-roam') ? 'roam'
    : app.classList.contains('mode-inspect') ? 'inspect' : 'scene'
  if (mode === 'inspect' && prevMode !== 'inspect') preInspectMode = prevMode

  app.classList.remove('mode-scene', 'mode-roam', 'mode-inspect')
  app.classList.add(`mode-${mode}`)
  $('roam-hint').style.display = 'none'
  // 检视面板在普通检查中直接展开；出题模式由专用工具栏接管。
  $('inspect-panel').style.display = 'none'
  $('inspect-result-trigger').style.display = 'none'
  $('inspect-edge-exit').style.display = 'none'
  if (mode !== 'inspect') $('inspect-panel').classList.remove('collapsed')

  // 先切场景状态（roam 时 enable playerController），再处理鼠标锁定
  scene?.setMode?.(mode)

  if (mode === 'roam') {
    const isTouch = scene?.isTouch() ?? false
    $('roam-hint-detail').textContent = isTouch
      ? `左摇杆移动 · 右半屏拖拽转视角 · ${state.profile?.mode === 'peer' ? '交互/提交/加速/跳跃/下蹲' : '交互/加速/跳跃/下蹲'}`
      : 'WASD 移动 · 空格跳跃 · Shift 奔跑 · C 下蹲 · E 交互 · Esc 退出漫游'
    $('touch-controls').style.display = isTouch ? 'block' : 'none'
    if (!roamHintShown) {
      roamHintShown = true
      $('roam-hint').style.display = 'block'
      clearTimeout(setMode.roamHintTimer)
      setMode.roamHintTimer = setTimeout(() => { $('roam-hint').style.display = 'none' }, 3000)
    }
  } else {
    $('touch-controls').style.display = 'none'
    $('vbtn-interact')?.classList.remove('ready')
    // 非漫游模式（场景/检视）释放鼠标锁定，让用户能点击面板/按钮
    scene?.releasePlayerLock?.()
  }
}

function setInspectPanelCollapsed(collapsed) {
  const panel = $('inspect-panel')
  if (!panel || panel.style.display === 'none') return
  panel.classList.toggle('collapsed', Boolean(collapsed))
}

/** 检视初始阶段不遮挡模型；只有要确认结果或已点到故障时才打开右侧窗口。 */
function openInspectResultPanel() {
  if (!activePoint) return
  $('inspect-result-trigger').style.display = 'none'
  $('inspect-panel').style.display = 'flex'
  setInspectPanelCollapsed(false)
}

function prepareInspectResultTrigger(point) {
  const trigger = $('inspect-result-trigger')
  trigger.querySelector('span').textContent = point?.isRouteEntry ? '完成安全确认' : '确认无异常'
  trigger.style.display = 'grid'
}

function showInspectPanel() {
  $('inspect-result-trigger').style.display = 'none'
  $('inspect-edge-exit').style.display = 'none'
  $('inspect-panel').style.display = 'flex'
  $('inspect-panel').classList.add('report-only')
  $('inspect-panel').classList.remove('collapsed')
}

function showInspectEdgeExit() {
  $('inspect-panel').style.display = 'none'
  $('inspect-result-trigger').style.display = 'none'
  $('inspect-edge-exit').style.display = 'grid'
}

// ───────────────────────── 检视流程 ─────────────────────────
function startInspection(item, route) {
  if (!scene) return
  const ok = scene.inspectItem(item, route)
  // 走行部零部件：inspectItem 只做「定位/提示」不进入检视，ok=false 是预期行为
  if (!ok && !RUNNING_GEAR_ITEM_IDS.has(item.id)) {
    showToast('该检查项暂无三维检视点位')
  }
}

function onInspectEnter(point) {
  activePoint = point
  pendingPoint = null
  authorTargetPoint = point.isStationPoint ? (point.stationParts?.[0] ?? null) : point
  setContextItem(point.itemId ?? point.item?.id)
  pendingMarker = null
  if (isAuthoring()) {
    authorFaultType = markersIn(point)?.[0]?.faultType ?? firstFaultType(authorTargetPoint)
    $('inspect-panel').style.display = 'none'
    $('inspect-result-trigger').style.display = 'none'
    $('inspect-edge-exit').style.display = 'grid'
    updateAuthorToolbar(authorTargetPoint)
    if (point.isRouteEntry) showToast('该点是安全确认入口，不用设置故障')
    return
  }
  const ref = $('inspect-reference')
  const refItem = point.item
  if (refItem?.points?.length) {
    $('inspect-points').innerHTML = refItem.points.map((p) => `<li>${p}</li>`).join('')
    $('inspect-standard').innerHTML = `<b>合格标准：</b>${refItem.standard}`
    ref.style.display = 'grid'
  } else {
    ref.style.display = 'none'
  }
  if (point.isRouteEntry) {
    // 升弓电气检查先确认外部安全条件；受电弓和车顶设备仍须逐项进入三维检视。
    $('inspect-title').textContent = '升弓电气检查（车外安全确认）'
    $('inspect-hint').textContent =
      '确认：①车顶无人 ②接触网无异物 ③接地线已挂 ④受电弓及车顶高压设备状态良好'
    $('inspect-wait').style.display = 'none'
    $('fault-report-form').style.display = 'none'
    $('inspect-progress').textContent = state.roofSafetyConfirmed ? '已确认' : '待确认'
    const st = $('inspect-status')
    st.textContent = '请完成车外安全确认'
    st.className = 'inspect-status'
    showInspectEdgeExit()
    return
  }
  $('inspect-title').textContent = point.isStationPoint
    ? point.stationLabel
    : `${point.route.shortName} · ${point.item.name}`
  $('inspect-hint').textContent = ''
  updateInspectProgress()
  // 故障符号说明暂时保留在 DOM 中，当前训练界面不显示。
  $('inspect-wait').style.display = 'none'
  $('fault-report-form').style.display = 'none'
  // 进入标准站位后先保留完整三维视野；点击故障标记时才展开填报窗口。
  showInspectEdgeExit()
}

function updateInspectProgress() {
  if (!activePoint) return
  const markers = markersIn(activePoint)
  const total = markers.length
  const found = markers.filter((m) => m.found).length
  $('inspect-progress').textContent = `${found} / ${total}`
  if (total && found === total) {
    $('inspect-status').textContent = '本部位故障已全部发现'
    $('inspect-status').className = 'inspect-status ok'
  } else {
    $('inspect-status').textContent = '继续旋转检视'
    $('inspect-status').className = 'inspect-status'
  }
}

function onMarkerPick(marker, point) {
  pendingMarker = marker
  pendingPoint = point
  pendingExpectedReport = expectedFaultReport(point, marker)
  configureFaultReportForm(pendingExpectedReport)
  $('report-locomotive').value ||= 'HXD3D 0004'
  // 同伴答题不预填标准答案；学员必须独立完成位置、部件和故障类型判断。
  $('report-end').value = ''
  $('report-side').value = ''
  $('report-axle').value = ''
  $('report-position').value = ''
  $('report-part').value = ''
  $('report-inner-outer').value = ''
  $('report-fault-type').value = ''
  $('fault-report-form').style.display = 'grid'
  openInspectResultPanel()
  if (!document.body.classList.contains('mobile-controls-enabled')) $('report-end').focus()
  showToast('已选中故障标记，请填写故障活件')
}

function normalizeEnd(value) {
  const v = String(value || '').trim().toUpperCase().replace(/\s|端/g, '')
  if (['1', '一', 'I', 'Ⅰ'].includes(v)) return 'I端'
  if (['2', '二', 'II', 'Ⅱ'].includes(v)) return 'II端'
  return ''
}

function normalizeAxle(value) {
  const v = String(value || '').trim().replace(/第|轴/g, '')
  const map = { 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', Ⅰ: '1', Ⅱ: '2', Ⅲ: '3', Ⅳ: '4', Ⅴ: '5', Ⅵ: '6' }
  const n = map[v] ?? v
  return /^[1-6]$/.test(n) ? `${n}轴` : ''
}

function normalizePart(value) {
  return String(value || '')
    .replace(/^[1-6一二三四五六ⅠⅡⅢⅣⅤⅥ]+轴/g, '')
    .replace(/[\s·、，,“”"'（）()]/g, '')
    .replace(/一系弹簧/g, '一系悬挂')
    .replace(/二系弹簧/g, '二系悬挂')
    .replace(/油压减震器/g, '油压减振器')
}

function reportPartName(point) {
  const p = point.part ?? {}
  return p.shortName || point.reportPartName || point.item?.fault?.reportPartName || point.item?.name || ''
}

function reportPartAliases(point, canonical) {
  const values = [
    canonical,
    point.part?.shortName,
    point.reportPartName,
    point.item?.fault?.reportPartName,
    ...(PART_TYPE_REPORT_ALIASES[point.part?.type] ?? []),
    ...(ITEM_REPORT_ALIASES[point.itemId ?? point.item?.id] ?? []),
  ]
  return [...new Set(values.map(normalizePart).filter(Boolean))]
}

function matchesReportPartName(value, expected) {
  const actual = normalizePart(value)
  if (!actual) return false
  return (expected.partAliases ?? [expected.partName]).some((alias) => {
    const normalized = normalizePart(alias)
    return normalized && (actual === normalized
      || (actual.length >= 2 && normalized.length >= 2
        && (actual.includes(normalized) || normalized.includes(actual))))
  })
}

function setReportFieldVisible(field, visible) {
  const wrapper = document.querySelector(`[data-report-field="${field}"]`)
  if (!wrapper) return
  wrapper.hidden = !visible
  const control = wrapper.querySelector('input, select')
  if (control) control.required = Boolean(visible && ['locomotive', 'end', 'side', 'axle', 'position', 'partName', 'innerOuter', 'faultType'].includes(field))
}

function configureFaultReportForm(expected) {
  // 端部、车顶等没有轴号/左右/里外语义的部件不显示无关字段，也不强制填写。
  setReportFieldVisible('locomotive', true)
  setReportFieldVisible('end', Boolean(expected?.end))
  setReportFieldVisible('side', Boolean(expected?.side))
  setReportFieldVisible('axle', Boolean(expected?.axle))
  setReportFieldVisible('position', Boolean(expected?.position))
  setReportFieldVisible('partName', true)
  setReportFieldVisible('innerOuter', Boolean(expected?.innerOuter))
  setReportFieldVisible('faultType', true)
}

function expectedFaultReport(point, marker) {
  const p = point.part ?? {}
  const partName = reportPartName(point)
  const exterior = point.fault?.exterior
  return {
    end: p.endLabel ?? (exterior === 'i-end' ? 'I端' : exterior === 'ii-end' ? 'II端' : ''),
    side: p.side === 'left' ? '左侧' : p.side === 'right' ? '右侧' : '',
    axle: p.axleNo ? `${p.axleNo}轴` : '',
    position: p.positionLabel ?? '',
    partName,
    partAliases: reportPartAliases(point, partName),
    innerOuter: p.side === 'left' || p.side === 'right' ? '外侧' : '',
    faultType: marker.faultType,
  }
  updateAuthorToolbar()
}

function isAuthoring() {
  return state.profile?.mode === 'author' && peerScenario?.status === 'draft'
}

function isPeerAnswering() {
  return state.profile?.mode === 'peer' && peerScenario?.status === 'answering'
}

function updatePeerSubmitButton() {
  const button = $('vbtn-submit')
  const group = button?.closest('.virtual-buttons')
  if (!button || !group) return
  const visible = document.body.classList.contains('session-running')
    && state.profile?.mode === 'peer'
    && peerScenario?.status === 'answering'
    && !state.finishedAt
  button.style.display = visible ? 'block' : 'none'
  group.classList.toggle('peer-submit-visible', visible)
}

function submitPeerAnswers() {
  if (!isPeerAnswering() || state.finishedAt) return
  finishTraining('答题同学主动提交')
}

function updateAuthorToolbar(point = authorTargetPoint ?? activePoint) {
  const toolbar = $('author-toolbar')
  if (!toolbar) return
  if (!isAuthoring() || !document.body.classList.contains('session-running')) {
    toolbar.style.display = 'none'
    return
  }
  toolbar.style.display = 'flex'
  $('author-count').textContent = String(peerScenario?.faults?.length ?? 0)
  const allowed = point && !point.isRouteEntry ? allowedFaultTypes(point) : []
  if (allowed.length && !allowed.includes(authorFaultType)) authorFaultType = allowed[0]
  const label = allowed.length ? (FAULT_TYPES[authorFaultType]?.label ?? authorFaultType) : '该部件暂不支持出题'
  $('author-type').textContent = allowed.length ? `故障类型：${label}` : label
  $('author-type').disabled = !allowed.length || !point || point.isRouteEntry || scene?.getMode?.() !== 'inspect'
  $('author-point').textContent = point && scene?.getMode?.() === 'inspect'
    ? `${point.part?.shortName ?? point.item?.name ?? '检查点'}：${allowed.length ? '点击任一可见零部件表面即可独立放置' : '请点击站位内其他已配置部件'}`
    : '走到标准站位并进入零部件检视'
  $('author-undo').disabled = !(peerScenario?.faults?.length)
}
function scoreFaultReport(report, expected) {
  const fields = [
    ['end', .10, normalizeEnd], ['side', .15, (v) => v], ['axle', .15, normalizeAxle],
    ['position', .10, (v) => v], ['partName', .20, normalizePart], ['innerOuter', .10, (v) => v], ['faultType', .20, (v) => v],
  ].filter(([key]) => Boolean(expected[key]))
  const available = fields.reduce((sum, [, weight]) => sum + weight, 0) || 1
  let score = 0
  const results = {}
  fields.forEach(([key, weight, norm]) => {
    const correct = key === 'partName'
      ? matchesReportPartName(report[key], expected)
      : norm(report[key]) === norm(expected[key])
    results[key] = correct
    if (correct) score += weight / available * 100
  })
  return { score: Math.round(score), results, expected }
}

function submitFaultReport(event) {
  event?.preventDefault?.()
  if (!pendingMarker || !pendingPoint || !activePoint) { showToast('请先点击三维画面中的故障标记'); return }
  const expected = pendingExpectedReport ?? expectedFaultReport(pendingPoint, pendingMarker)
  const end = normalizeEnd($('report-end').value)
  const side = $('report-side').value
  const axleRaw = $('report-axle').value.trim()
  const axle = axleRaw ? normalizeAxle(axleRaw) : ''
  const partName = $('report-part').value.trim()
  const faultType = $('report-fault-type').value
  if (expected.end && !end) { showToast('“哪节车或哪端”请填写 I端/II端、1端/2端或一端/二端'); return }
  if (expected.side && !side) { showToast('请选择左侧或右侧（以司机 I 端方向为准）'); return }
  if (expected.axle && !axle) { showToast('请填写正确轴号：1—6 或对应中文、罗马数字'); return }
  if (expected.position && !$('report-position').value) { showToast('请选择前后位置'); return }
  if (expected.innerOuter && !$('report-inner-outer').value) { showToast('请选择里侧或外侧'); return }
  if (!partName) { showToast('请填写部件名称'); return }
  if (!faultType) { showToast('请选择故障类型'); return }

  const report = {
    locomotive: $('report-locomotive').value.trim(), end, side, axle,
    position: $('report-position').value, partName,
    innerOuter: $('report-inner-outer').value,
    faultType, faultLabel: FAULT_TYPES[faultType].label,
    pointId: pendingPoint.id,
    faultId: pendingMarker.faultId,
  }
  report.accuracy = scoreFaultReport(report, expected)
  // 一次“确定”必须完整结束本次站位检视。先登记答案，再统一退出；
  // 同一站位若还有其他故障，学员可从漫游状态重新进入继续查找。
  try {
    scene?.markFound?.(pendingMarker)
    recordFaultFound(pendingPoint, report)
    showFeedback(true, '故障填报已记录', '已退出当前零部件检视，填报准确性将在成绩单中统一评定。')
    refreshProgress()
    renderRouteList()
  } finally {
    pendingMarker = null
    pendingPoint = null
    pendingExpectedReport = null
    $('fault-report-form').style.display = 'none'
    exitInspect()
  }
  maybeFinishTraining()
}

function composeFaultReport(report) {
  return [report.locomotive, report.end, report.side, report.axle, report.position,
    report.partName, report.innerOuter, report.faultLabel].filter(Boolean).join('，')
}

function recordFaultFound(point, report) {
  // 走行部语义点以 itemId 挂接；端部等旧检查点仍可能直接携带 item。
  // 两种数据形态都必须落到同一检查项记录中，否则标记虽被点亮却没有评分依据。
  const item = point.item ?? itemIndex.get(point.itemId)?.item
  if (!item) {
    showToast('该故障未关联检查项，无法保存填报记录')
    return
  }
  const total = point.markers.length
  const found = point.markers.filter((m) => m.found).length
  const r = state.items[item.id] ?? { time: formatNow() }
  r.status = 'ng'
  r.partRecords = {
    ...(r.partRecords ?? {}),
    [point.id]: { status: 'ng', faultsTotal: total, faultsFound: found, time: formatNow() },
  }
  const partRecords = Object.values(r.partRecords)
  r.faultsTotal = partRecords.reduce((sum, rec) => sum + (rec.faultsTotal ?? 0), 0)
  r.faultsFound = partRecords.reduce((sum, rec) => sum + (rec.faultsFound ?? 0), 0)
  const existingIndex = (r.faultReports ?? []).findIndex((entry) => entry.faultId && entry.faultId === report.faultId)
  r.faultReports = existingIndex >= 0
    ? (r.faultReports ?? []).map((entry, index) => index === existingIndex ? report : entry)
    : [...(r.faultReports ?? []), report]
  r.note = r.faultReports.map(composeFaultReport).join('；')
  r.action = '报修临修'
  r.level = '立即处理'
  r.time = formatNow()
  state.items[item.id] = r
  if (point.isPartPoint && !activePoint?.isStationPoint && found >= total) {
    scene?.getPartFSM?.()?.judge(point.part.partId, {
      status: 'ng', note: composeFaultReport(report), faultsFound: found, faultsTotal: total,
    })
  }
  saveState()
  // 同步刷新该项卡片
  renderRouteDetail()
}

function showFeedback(ok, title, detail) {
  const fb = $('fault-feedback')
  fb.className = `fault-feedback ${ok ? 'ok' : 'ng'}`
  fb.innerHTML = `<strong>${title}</strong><small>${detail}</small>`
  fb.style.display = 'block'
  clearTimeout(showFeedback.timer)
  showFeedback.timer = setTimeout(() => { fb.style.display = 'none' }, 2600)
}

function exitInspect() {
  if (activePoint?.isPartPoint && !activePoint?.isStationPoint) {
    scene?.getPartFSM?.()?.cancelInspect(activePoint.part.partId)
  }
  activePoint = null
  pendingMarker = null
  pendingPoint = null
  pendingExpectedReport = null
  authorTargetPoint = null
  $('fault-report-form').style.display = 'none'
  $('inspect-reference').style.display = 'none'
  $('inspect-result-trigger').style.display = 'none'
  $('inspect-edge-exit').style.display = 'none'
  setContextItem(null)
  $('inspect-panel').style.display = 'none'
  // 返回进入检视前的模式（漫游或场景）
  setMode(preInspectMode)
  updateAuthorToolbar(null)
}

/** 右上角叉号表示本次检视未发现需上报的问题，并完成该检查点。 */
function closeInspectAsNormal() {
  if (!activePoint) return
  if (isAuthoring()) { exitInspect(); return }
  pendingMarker = null
  pendingPoint = null
  $('fault-report-form').style.display = 'none'
  decideFromInspect('ok')
}

/** 检视面板内直接记录合格/异常，闭环 8 步状态机（移动端友好） */
function decideFromInspect(action) {
  if (!activePoint) return
  // 环节入口点只确认车外安全条件，不能替代受电弓及车顶设备的逐项检查。
  if (activePoint.isRouteEntry) {
    state.roofSafetyConfirmed = action === 'ok'
    saveState()
    showToast(action === 'ok' ? '已确认车外安全条件，请逐项检视受电弓和车顶设备' : '请按作业标准处理车外安全条件后再检查')
    refreshProgress(); renderRouteList(); renderRouteDetail()
    exitInspect()
    maybeFinishTraining()
    return
  }
  const judgedPoints = semanticPointsIn(activePoint)
  for (const point of judgedPoints) {
    const item = point.item ?? itemIndex.get(point.itemId)?.item
    if (!item) continue
    const prev = state.items[item.id] ?? {}
    const previousPartRecord = prev.partRecords?.[point.id]
    const partFound = point.markers?.filter((m) => m.found).length ?? 0
    const alreadyReported = partFound > 0
      || previousPartRecord?.status === 'ng'
      || (prev.faultReports ?? []).some((report) => report.pointId === point.id)
    // 重进站位后的“未见异常”只完成尚未判定的实体，不能覆盖已经上报的故障。
    const pointStatus = action === 'ok' && alreadyReported ? 'ng' : action
    const partRecords = {
      ...(prev.partRecords ?? {}),
      [point.id]: {
        status: pointStatus,
        faultsTotal: point.markers?.length ?? 0,
        faultsFound: partFound,
        time: formatNow(),
      },
    }
    const records = Object.values(partRecords)
    state.items[item.id] = {
      ...prev,
      status: records.some((rec) => rec.status === 'ng') ? 'ng' : action,
      partRecords,
      faultsTotal: records.reduce((sum, rec) => sum + (rec.faultsTotal ?? 0), 0),
      faultsFound: records.reduce((sum, rec) => sum + (rec.faultsFound ?? 0), 0),
      time: formatNow(),
    }
  }
  saveState()
  // 同步 FSM 运行时（走行部零部件）
  const fsm = scene?.getPartFSM?.()
  if (fsm && activePoint.isPartPoint && !activePoint.isStationPoint) fsm.judge(activePoint.part.partId, { status: action })
  const judgedLabel = activePoint.stationLabel ?? activePoint.item?.name ?? '当前部件'
  showToast(action === 'ok' ? `已确认合格：${judgedLabel}` : `已登记异常：${judgedLabel}`)
  refreshProgress()
  renderRouteList()
  renderRouteDetail()
  exitInspect()
  maybeFinishTraining()
}

// ───────────────────────── 结果汇总 ─────────────────────────
function renderReport({ final = false } = {}) {
  const g = globalStats()
  const f = faultStats()
  if (!final && !state.finishedAt && g.done !== g.total) {
    showToast(`请完成全部检查，或等待训练计时结束后生成成绩单（当前 ${g.done}/${g.total}）`)
    return
  }
  const issues = []
  const unfinished = []
  INSPECTION_ROUTES.forEach((route) => {
    route.items.forEach((item) => {
      const r = state.items[item.id]
      if (r?.status === 'ng') issues.push({ route, item, record: r })
      else if (!r) unfinished.push({ route, item })
    })
  })
  $('report-sub').textContent = ` · ${INSPECTION_META.locomotive} · ${state.sessionId}`
  const modeLabel = state.profile?.mode === 'assessment' ? '考评模式'
    : state.profile?.mode === 'peer' ? '同伴答题'
      : state.profile?.mode === 'author' ? '同伴出题' : '练习模式'
  $('report-note').innerHTML =
    `检查人：${state.operator} · 工号/学号：${state.profile?.id || '—'} · 班级/班组：${state.profile?.group || '—'} · ${modeLabel} · 开始时间：${state.startTime}` +
    (state.finishedAt ? ` · 结束时间：${state.finishedAt} · ${state.finishReason}` : '') +
    `<br>${INSPECTION_META.disclaimer}`

  const score = computeScore({
    routes: INSPECTION_ROUTES,
    getItem: (id) => state.items[id],
    getPoints: scorePointsForItem,
    getPointTotal: pointTotalForItem,
    getFaultTotal: faultTotalForItem,
  })
  $('report-body').innerHTML = `
    <div class="report-summary">
      <div class="report-stat"><b>${g.total}</b><small>检查项总数</small></div>
      <div class="report-stat ok"><b>${g.ok}</b><small>合格</small></div>
      <div class="report-stat ng"><b>${g.ng}</b><small>异常</small></div>
      <div class="report-stat warn"><b>${unfinished.length}</b><small>未检</small></div>
    </div>
    <div class="report-summary">
      <div class="report-stat ok"><b>${f.found}/${f.total}</b><small>故障标记检出</small></div>
      <div class="report-stat"><b>${Math.round(f.rate * 100)}%</b><small>检出率</small></div>
      <div class="report-stat"><b>${score.total}</b><small>综合得分</small></div>
      <div class="report-stat ${score.pass ? 'ok' : 'ng'}"><b>${score.pass ? '合格' : '不合格'}</b><small>评定</small></div>
    </div>
    <div class="report-section">
      <h4>逐项评分（实体覆盖、故障检出与填报准确度）</h4>
      <table class="report-table"><thead><tr><th>部位</th><th>检查项</th><th>检查覆盖</th><th>故障检出</th><th>填报准确</th><th>得分</th></tr></thead>
      <tbody>${score.items.map((s) => `<tr><td>${s.route.shortName}</td><td>${s.item.name} <small>${s.scored ? `(${s.max}分)` : '（不计分）'}</small></td><td>${s.checked}/${s.pointTotal}</td><td>${s.faultTotal ? `${s.found}/${s.faultTotal}` : '—'}</td><td>${s.faultTotal ? `${s.reportAccuracy}%` : '—'}</td><td><b>${s.scored ? `${s.earned}/${s.max}` : '—'}</b></td></tr>`).join('')}</tbody></table>
      ${score.blocking ? '<p class="report-warning">存在 A 类关键项未完成或严重故障漏检，本次成绩判定为不合格。</p>' : ''}
    </div>
    <div class="report-section">
      <h4>异常登记明细</h4>
      ${issues.length ? `
        <table class="report-table">
          <thead><tr>
            <th style="width:50px">序号</th><th>部位</th><th>检查项</th><th style="width:70px">等级</th>
            <th>现象描述</th><th style="width:80px">故障检出</th>
            <th style="width:90px">处置方式</th><th style="width:90px">处置时限</th>
          </tr></thead>
          <tbody>
            ${issues.map(({ route, item, record }) => `
              <tr>
                <td>${itemIndex.get(item.id).serial}</td>
                <td>${route.shortName}</td>
                <td class="ng">${item.name}</td>
                <td>${LEVEL_LABELS[item.level]?.text ?? ''}</td>
                <td>${escapeHtml(record.note || '—')}</td>
                <td>${record.faultsTotal ? `${record.faultsFound ?? 0}/${record.faultsTotal}` : '—'}</td>
                <td>${escapeHtml(record.action || '—')}</td>
                <td>${escapeHtml(record.level || '—')}</td>
              </tr>`).join('')}
          </tbody>
        </table>` : '<div class="report-empty">本次检查未登记异常项目。</div>'}
    </div>
    <div class="report-section">
      <h4>未检查项目（${unfinished.length}）</h4>
      ${unfinished.length ? `
        <table class="report-table">
          <thead><tr><th style="width:50px">序号</th><th>部位</th><th>检查项</th><th style="width:70px">等级</th></tr></thead>
          <tbody>
            ${unfinished.map(({ route, item }) => `
              <tr><td>${itemIndex.get(item.id).serial}</td><td>${route.shortName}</td>
              <td>${item.name}</td><td>${LEVEL_LABELS[item.level]?.text ?? ''}</td></tr>`).join('')}
          </tbody>
        </table>` : '<div class="report-empty">全部检查项均已完成确认。</div>'}
    </div>`
  $('report-mask').style.display = 'grid'
}

function exportRecord() {
  const f = faultStats()
  const rows = [['序号', '部位', '检查项', '等级', '结果', '故障检出', '现象描述', '处置方式', '处置时限', '记录时间']]
  INSPECTION_ROUTES.forEach((route) => {
    route.items.forEach((item) => {
      const r = state.items[item.id]
      const status = r?.status === 'ok' ? '合格' : r?.status === 'ng' ? '异常' : '未检'
      const fs = r?.faultsTotal ? `${r.faultsFound ?? 0}/${r.faultsTotal}` : ''
      rows.push([
        itemIndex.get(item.id).serial, route.shortName, item.name,
        LEVEL_LABELS[item.level]?.text ?? '', status, fs,
        r?.note ?? '', r?.action ?? '', r?.level ?? '', r?.time ?? '',
      ])
    })
  })
  rows.push([])
  rows.push(['故障检出合计', `${f.found}/${f.total}`, '检出率', `${Math.round(f.rate * 100)}%`])
  const csv = '\uFEFF' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `机车检查记录_${state.sessionId}.csv`
  a.click()
  URL.revokeObjectURL(url)
  showToast('检查记录已导出为 CSV')
}

// ───────────────────────── 视角预设 ─────────────────────────
const VIEW_PRESETS = {
  overview: { dir: [0.55, 0.5, 1], distance: 0.85, label: '整车' },
  front: { dir: [-1.15, 0.42, 0.72], distance: 0.6, label: '端部' },
  left: { dir: [0.05, 0.28, 1.5], distance: 0.66, label: '左侧' },
  right: { dir: [0.05, 0.28, -1.5], distance: 0.66, label: '右侧' },
  top: { dir: [0.25, 1.35, 0.45], distance: 0.8, label: '顶部' },
  bottom: { dir: [0.35, -0.62, 1.0], distance: 0.62, label: '底部' },
}
function applyViewPreset(key) {
  const p = VIEW_PRESETS[key]
  if (!p) return
  scene?.focusRoute({
    id: `__view_${key}`,
    focus: { type: 'region', regions: [{ u: [0, 1], v: [0, 1], w: [0, 1] }], camera: { dir: p.dir, distance: p.distance } },
  })
  document.querySelectorAll('#view-dock button').forEach((b) => b.classList.toggle('active', b.dataset.view === key))
  showToast(`视角：${p.label}`)
}

// ───────────────────────── 虚拟摇杆 / 按键 ─────────────────────────
function initVirtualJoystick() {
  const base = $('joystick')
  const pad = base?.querySelector('.joystick-base')
  const stick = $('joystick-stick')
  if (!base || !pad || !stick) return
  let activeId = null
  const R = 50
  const zoneHint = $('touch-zone-hint')
  const move = (e) => {
    if (e.pointerId !== activeId) return
    e.preventDefault()
    const rect = pad.getBoundingClientRect()
    let dx = e.clientX - (rect.left + rect.width / 2)
    let dy = e.clientY - (rect.top + rect.height / 2)
    const len = Math.hypot(dx, dy)
    if (len > R) { dx = dx / len * R; dy = dy / len * R }
    stick.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`
    scene?.setPlayerInput?.({ x: dx / R, y: dy / R })
  }
  const start = (e) => {
    if (scene?.getMode() !== 'roam' || activeId !== null) return
    e.preventDefault()
    activeId = e.pointerId
    pad.setPointerCapture?.(activeId)
    pad.classList.add('active')
    move(e)
    if (zoneHint) zoneHint.style.display = 'none'
  }
  const end = (e) => {
    if (e.pointerId !== activeId) return
    activeId = null
    pad.classList.remove('active')
    stick.style.transform = 'translate(-50%, -50%)'
    scene?.setPlayerInput?.({ x: 0, y: 0 })
  }
  pad.addEventListener('pointerdown', start)
  pad.addEventListener('pointermove', move)
  pad.addEventListener('pointerup', end)
  pad.addEventListener('pointercancel', end)
  pad.addEventListener('lostpointercapture', end)
}

/** 右侧独立视角摇杆（移动端，不依赖整屏拖拽） */
function initViewJoystick() {
  const base = $('view-joystick')
  const stick = $('view-joystick-stick')
  if (!base) return
  let active = false
  let id = null
  const R = 46
  const move = (e) => {
    if (!active) return
    const ts = e.touches ? [...e.touches] : [e]
    const t = ts.find((x) => x.identifier === id) || ts[0]
    if (!t) return
    e.preventDefault()
    const rect = base.getBoundingClientRect()
    let dx = t.clientX - (rect.left + rect.width / 2)
    let dy = t.clientY - (rect.top + rect.height / 2)
    const len = Math.hypot(dx, dy)
    if (len > R) { dx = dx / len * R; dy = dy / len * R }
    stick.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`
    scene?.setLookVector?.(dx / R, dy / R)
  }
  const start = (e) => {
    if (scene?.getMode() !== 'roam') return
    const ts = e.changedTouches ? [...e.changedTouches] : [e]
    id = ts[0]?.identifier ?? null
    active = true
    base.classList.add('show')
    move(e)
  }
  const endf = (e) => {
    if (!active) return
    const ts = e.changedTouches ? [...e.changedTouches] : [e]
    if (ts.some((x) => x.identifier === id)) return
    active = false; id = null
    base.classList.remove('show')
    stick.style.transform = 'translate(-50%, -50%)'
    scene?.setLookVector?.(0, 0)
  }
  base.addEventListener('touchstart', start, { passive: false })
  base.addEventListener('touchmove', move, { passive: false })
  base.addEventListener('touchend', endf)
  base.addEventListener('touchcancel', endf)
  base.addEventListener('mousedown', start)
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', endf)
}

function initVirtualButtons() {
  document.querySelectorAll('.vbtn[data-btn]').forEach((btn) => {
    const name = btn.dataset.btn
    let pointerId = null
    const press = (e) => {
      if (scene?.getMode() !== 'roam' || pointerId !== null) return
      e.preventDefault()
      pointerId = e.pointerId
      btn.setPointerCapture?.(pointerId)
      btn.classList.add('active')
      scene?.setPlayerButton?.(name, true)
    }
    const release = (e) => {
      if (e.pointerId !== pointerId) return
      e.preventDefault()
      pointerId = null
      btn.classList.remove('active')
      scene?.setPlayerButton?.(name, false)
    }
    btn.addEventListener('pointerdown', press)
    btn.addEventListener('pointerup', release)
    btn.addEventListener('pointercancel', release)
    btn.addEventListener('lostpointercapture', release)
  })
}

function isMobileTrainingDevice() {
  return document.body.classList.contains('mobile-controls-enabled')
}

function requestMobileLandscape() {
  if (!isMobileTrainingDevice()) return Promise.resolve(false)
  if (landscapeRequest) return landscapeRequest
  landscapeRequest = (async () => {
    let fullscreenReady = Boolean(document.fullscreenElement)
    try {
      if (!fullscreenReady && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' })
        fullscreenReady = Boolean(document.fullscreenElement)
      }
    } catch {
      // iOS Safari 及部分内嵌浏览器禁止网页主动全屏；仍继续尝试横屏锁定。
    }
    try {
      await screen.orientation?.lock?.('landscape')
      return true
    } catch {
      return fullscreenReady
    }
  })()
  landscapeRequest.finally(() => { landscapeRequest = null })
  return landscapeRequest
}

function initMobileFullscreen() {
  const button = $('mobile-fullscreen')
  if (!button) return
  if (!isMobileTrainingDevice()) return

  // 必须由“进入训练”或全屏按钮这一类明确手势触发；表单输入阶段不抢占横屏。
  button.addEventListener('click', () => { requestMobileLandscape() })
}

function initMobileExit() {
  const button = $('mobile-exit')
  if (!button) return
  button.addEventListener('click', () => {
    scene?.releasePlayerLock?.()
    try { window.parent?.postMessage({ type: 'hxd3d-inspection-close' }, '*') } catch {}
    const exitFullscreen = document.exitFullscreen?.()
    exitFullscreen?.catch(() => {})
    // App/WebView 可关闭本页；普通浏览器基于安全策略不可强制关闭非脚本打开的标签。
    window.close()
    window.setTimeout(() => {
      if (!window.closed && window.history.length > 1) window.history.back()
      else if (!window.closed) window.location.replace('about:blank')
    }, 120)
  })
}

function openSessionGate() {
  clearTimeout(trainingChromeTimer)
  $('app').classList.remove('training-chrome-hidden')
  document.body.classList.remove('session-running')
  document.body.classList.add('session-entry')
  const p = state.profile ?? {}
  $('session-name').value = p.name ?? ''
  $('session-id').value = p.id ?? ''
  $('session-group').value = p.group ?? ''
  $('session-device').value = p.device || $('session-device').value
  const answerAvailable = ['locked', 'answering'].includes(peerScenario?.status)
  $('session-mode').value = answerAvailable ? 'peer' : 'author'
  $('session-tip').textContent = window.__sceneReady ? '三维模型已就绪，可以进入训练。' : '正在载入三维模型，请稍候。'
  $('session-enter').disabled = !window.__sceneReady
  $('session-gate').style.display = 'grid'
  updatePeerSubmitButton()
  updateAuthorToolbar(null)
}

function finishAuthoring() {
  if (!isAuthoring()) return
  if (!(peerScenario?.faults?.length)) {
    showToast('至少需要设置 1 处假设性故障')
    return
  }
  peerScenario = lockPeerScenario(peerScenario)
  if (!peerScenario) return
  if (scene?.getMode?.() === 'inspect') exitInspect()
  scene?.releasePlayerLock?.()
  state.profile = {
    ...(state.profile ?? {}),
    name: '', id: '', group: '', mode: 'peer',
  }
  openSessionGate()
  $('session-name').value = ''
  $('session-id').value = ''
  $('session-group').value = ''
  $('session-mode').value = 'peer'
  $('session-tip').textContent = `题目已锁定：共 ${peerScenario.faults.length} 处故障。请由答题同学填写身份信息后进入。`
}

function beginSession() {
  const name = $('session-name').value.trim()
  const id = $('session-id').value.trim()
  if (!name || !id) { $('session-tip').textContent = '请填写学员姓名和工号/学号。'; return }
  const selectedMode = $('session-mode').value
  if (selectedMode === 'peer' && !['locked', 'answering'].includes(peerScenario?.status)) {
    $('session-tip').textContent = '当前没有已完成的同伴题目，请先选择“同伴出题”。'
    return
  }
  state.profile = { name, id, group: $('session-group').value.trim(), device: $('session-device').value, mode: selectedMode }
  state.operator = name
  $('btn-report').textContent = selectedMode === 'author' ? '完成出题' : '提交作业'
  if (selectedMode === 'author') {
    // 每位出题同学进入时都创建一张全新的空白题目，不继承任何预置或旧草稿故障。
    peerScenario = savePeerScenario(createPeerScenario(state.profile))
    scene?.configureScenario?.('author', peerScenario)
  } else if (selectedMode === 'peer') {
    peerScenario = markPeerScenarioAnswering(loadPeerScenario())
    if (!peerScenario) {
      $('session-tip').textContent = '题目数据无效，请重新完成一次同伴出题。'
      return
    }
    scene?.configureScenario?.('peer', peerScenario)
  }
  // 仍在 click 用户手势栈内请求横屏；iPhone Safari 若拒绝锁定，会保留旋转提示，不阻塞登录。
  document.body.classList.remove('session-entry')
  document.body.classList.add('session-running')
  requestMobileLandscape()
  clearTimeout(trainingChromeTimer)
  $('app').classList.remove('training-chrome-hidden')
  // 训练开始五秒后收起顶部系统栏，保留退出键，避免遮挡走行部检视视野。
  trainingChromeTimer = window.setTimeout(() => {
    $('app').classList.add('training-chrome-hidden')
  }, 5000)
  resetState()
  flow.setCurrent(0)
  currentRouteIndex = 0
  scene?.resetMarkers?.()
  $('session-gate').style.display = 'none'
  updatePeerSubmitButton()
  updateSessionTimer(); renderRouteList(); renderRouteDetail(); refreshProgress()
  updateAuthorToolbar(null)
  const startMessage = selectedMode === 'author'
    ? '同伴出题已开始：到达检查站位，进入检视后点击零部件外表面。'
    : `同伴答题已开始：本题共 ${peerScenario.faults.length} 处假设故障。`
  showToast(startMessage)
}

// ───────────────────────── 启动 ─────────────────────────
function init() {
  // 手机端标记（用于横屏 CSS 规则与安全区适配）
  const isCoarse = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window
    || new URLSearchParams(location.search).get('mobile') === '1'
  if (isCoarse) document.body.classList.add('mobile-controls-enabled')
  document.body.classList.add('session-entry')

  const restored = loadState()
  if (!state.sessionId) {
    resetState()
  } else if (!state.deadlineAt) {
    // 旧版本本地存档没有计时字段，从本次打开起补齐一轮完整训练时限。
    state.deadlineAt = Date.now() + SESSION_LIMIT_SECONDS * 1000
    saveState()
  }
  updateSessionTimer()
  clearInterval(sessionTimer)
  sessionTimer = setInterval(updateSessionTimer, 1000)
  // 恢复时定位到第一个未完成的阶段（状态机起始位置）
  let firstPending = 0
  for (let i = 0; i < INSPECTION_ROUTES.length; i += 1) {
    if (!flow.stageOf(i).completed) { firstPending = i; break }
  }
  flow.setCurrent(firstPending)
  currentRouteIndex = firstPending

  $('title-sub').textContent = `LOCOMOTIVE INSPECTION OPERATION · ${INSPECTION_META.version}`
  $('progress-detail').textContent = `共 ${INSPECTION_ROUTES.length} 个部位 · ${TOTAL_ITEM_COUNT} 个检查项`
  renderRouteList()
  renderRouteDetail()
  refreshProgress()

  $('btn-next').addEventListener('click', () => {
    // 状态机推进：校验当前阶段完成
    const res = flow.advance()
    if (!res.ok) { showToast(res.reason); return }
    selectRoute(res.stage, { focus: true })
  })
  $('btn-report').addEventListener('click', () => {
    if (isAuthoring()) finishAuthoring()
    else renderReport()
  })
  $('report-close').addEventListener('click', () => { $('report-mask').style.display = 'none' })
  $('btn-export').addEventListener('click', exportRecord)
  $('btn-print').addEventListener('click', () => window.print())
  $('btn-reset').addEventListener('click', () => {
    if (!window.confirm('确定清空全部检查记录并重新开始吗？')) return
    resetState()
    flow.setCurrent(0)
    currentRouteIndex = 0
    scene?.resetMarkers?.()
    $('report-mask').style.display = 'none'
    updateSessionTimer()
    renderRouteList(); renderRouteDetail(); refreshProgress()
    showToast('检查记录已清空')
  })
  $('toggle-all').addEventListener('click', () => {
    expandedAll = !expandedAll
    document.querySelectorAll('.item-card').forEach((c) => {
      c.classList.toggle('open', expandedAll)
      const t = c.querySelector('.item-toggle')
      if (t) t.textContent = expandedAll ? '收起 ▴' : '展开 ▾'
    })
    $('toggle-all').textContent = expandedAll ? '全部收起' : '全部展开'
  })
  document.querySelectorAll('#view-dock button').forEach((b) => {
    b.addEventListener('click', () => applyViewPreset(b.dataset.view))
  })
  // 移动端抽屉：点击手柄展开 / 互斥关闭
  document.querySelectorAll('.drawer-handle').forEach((handle) => {
    handle.addEventListener('click', (e) => {
      e.stopPropagation()
      const which = handle.dataset.drawer
      const target = $(`${which}-shell`)
      const wasExpanded = target.classList.contains('expanded')
      document.querySelectorAll('.left-shell, .right-shell').forEach((el) => el.classList.remove('expanded'))
      if (!wasExpanded) target.classList.add('expanded')
    })
  })
  // 点击 3D 区域收起抽屉（不冲突 OrbitControls —— drawer pointer-events:none 时不拦截）
  $('three-host').addEventListener('pointerdown', () => {
    document.querySelectorAll('.left-shell.expanded, .right-shell.expanded').forEach((el) => el.classList.remove('expanded'))
  })
  // 默认已进入漫游；桌面端仅在用户点击三维画面后锁定鼠标，避免加载时强制锁定失败。
  $('three-host').addEventListener('click', () => {
    if (scene?.getMode?.() === 'roam' && !scene?.isTouch?.()) scene.requestPlayerLock?.()
  })

  // 检视面板
  $('inspect-exit').addEventListener('click', closeInspectAsNormal)
  $('inspect-edge-exit').addEventListener('click', closeInspectAsNormal)
  $('inspect-result-trigger').addEventListener('click', openInspectResultPanel)
  $('fault-report-form').addEventListener('submit', submitFaultReport)
  $('session-enter').addEventListener('click', beginSession)
  $('session-mode').addEventListener('change', () => {
    const mode = $('session-mode').value
    if (mode === 'peer') {
      $('session-tip').textContent = ['locked', 'answering'].includes(peerScenario?.status)
        ? `已有同伴题目，共 ${peerScenario.faults.length} 处故障。`
        : '尚无同伴题目，请先选择“同伴出题”。'
    } else if (mode === 'author') {
      $('session-tip').textContent = '进入后创建全新空白题目；旧题不会带入本次出题。'
    }
  })
  $('author-type').addEventListener('click', () => {
    const point = authorTargetPoint ?? activePoint
    if (!isAuthoring() || !point || scene?.getMode?.() !== 'inspect') return
    authorFaultType = nextFaultType(point, authorFaultType)
    updateAuthorToolbar(point)
  })
  $('author-undo').addEventListener('click', () => {
    if (!isAuthoring()) return
    peerScenario = removeLastScenarioFault(peerScenario)
    scene?.configureScenario?.('author', peerScenario)
    updateAuthorToolbar(authorTargetPoint ?? activePoint)
    showToast('已撤销上一处故障')
  })
  $('author-finish').addEventListener('click', finishAuthoring)
  $('vbtn-submit').addEventListener('click', submitPeerAnswers)
  // Esc 与面板叉号含义一致：普通检查记为未见异常，出题模式仅退出当前检视。
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && scene?.getMode?.() === 'inspect') {
      e.preventDefault()
      closeInspectAsNormal()
    }
  })

  initVirtualJoystick()
  initVirtualButtons()
  initMobileFullscreen()
  initMobileExit()

  scene = createInspectionScene($('three-host'), {
    // GitHub Pages 的 GLB 分段传输不总会给出可信总长度，不能拿它计算百分比。
    onProgress: () => {},
    onModelSource: (s) => {
      modelSourceLabel = s === 'local' ? '本地副本' : '引用孪生平台'
      $('foot-model').textContent = modelSourceLabel
    },
    onLoaded: () => {
      window.__sceneReady = true
      $('loading-bar').style.width = '100%'
      $('loading-text').textContent = '三维模型加载完成 · 100%'
      scene.buildPoints(INSPECTION_ROUTES)
      const pts = scene.getInteractionPoints?.() ?? scene.getInspectionPoints()
      $('foot-point').textContent = `${pts.length} 个`
      refreshProgress()
      selectRoute(currentRouteIndex, { focus: false })
      if (restored && state.profile?.name) showToast('已恢复上次未完成的检查记录')
      // ★ 默认直接进入漫游模式（第一人称视角），点击画面锁定鼠标
      setMode('roam')
      showToast('漫游模式已就绪')
      // 让完成态在画面中保留一瞬，再进入系统，避免显示不可信的中间百分比。
      window.setTimeout(() => { $('loading').style.display = 'none'; openSessionGate() }, 180)
    },
    onError: (e) => {
      $('loading-text').textContent = `三维模型加载失败：${e?.message ?? e}`
      $('loading-bar').style.width = '100%'
    },
    onToast: (m) => showToast(m),
    // FSM 第①步「检查项已解锁」：随所属部位路由解锁
    isItemUnlocked: (itemId) => {
      const ri = INSPECTION_ROUTES.findIndex((r) => r.items.some((i) => i.id === itemId))
      if (ri < 0) return true
      return ri >= 0
    },
    // 环节入口点（升弓电气检查车外点）是否可进入：随该部位路由解锁
    isRouteUnlocked: (routeId) => {
      const ri = INSPECTION_ROUTES.findIndex((r) => r.id === routeId)
      return ri >= 0
    },
    onPointerLockChange: (locked) => {
      $('roam-hint-detail').textContent = locked
        ? 'WASD 移动 · 空格跳跃 · Shift 奔跑 · C 下蹲 · E 交互 · Esc 退出'
        : '点击画面锁定鼠标 · WASD 移动 · 空格跳跃 · E 交互'
    },
    onPointerLockError: () => showToast('鼠标锁定失败，请点击画面重试'),
    onNearPoint: (desc) => {
      const hint = $('near-hint')
      // 中央提示框不再占用视野；到位并对准时仅让右侧交互键变为绿色半透明。
      hint.style.display = 'none'
      const button = $('vbtn-interact')
      if (!button) return
      button.classList.toggle('ready', Boolean(desc?.canEnter))
      button.querySelector('.vbtn-hint').textContent = desc?.canEnter ? '可检视' : '检查部件'
    },
    onInspectEnter: (point) => {
      // 漫游按 E 进入检视时，sceneController 内部已切到 inspect，
      // 但 UI 层（面板显示/释放鼠标锁定/记录返回模式）需要这里同步。
      setMode('inspect')
      onInspectEnter(point)
    },
    onInspectExit: () => {
      activePoint = null
      pendingMarker = null
      pendingPoint = null
      pendingExpectedReport = null
      authorTargetPoint = null
    },
    onMarkerPick: (marker, point) => onMarkerPick(marker, point),
    getAuthorFaultType: (point) => {
      const allowed = allowedFaultTypes(point)
      return allowed.includes(authorFaultType) ? authorFaultType : allowed[0]
    },
    onAuthorFaultPlaced: (record, point, marker, station) => {
      record.stationId = station?.isStationPoint ? station.id : ''
      peerScenario = upsertScenarioFault(peerScenario, record)
      authorFaultType = record.faultType
      authorTargetPoint = point
      updateAuthorToolbar(point)
      showToast(`已在${point.part?.shortName ?? point.item?.name ?? '部件'}外表面设置故障`)
    },
    onAuthorFaultGeometry: (record) => {
      // 切换故障类型后，sceneController 会重新按曲面投影顶点；同步保存新几何。
      peerScenario = upsertScenarioFault(peerScenario, record)
    },
    onAuthorMarkerTap: (marker, point) => {
      const type = nextFaultType(point, marker.faultType)
      peerScenario = updateScenarioFaultType(peerScenario, marker.faultId, type)
      authorFaultType = type
      authorTargetPoint = point
      scene?.configureScenario?.('author', peerScenario)
      updateAuthorToolbar(point)
      showToast(`已切换为：${FAULT_TYPES[type]?.label ?? type}`)
    },
    onModeChange: () => {},
  })

  // 部位标注牌（场景模式）
  // 性能：漫游/检视时跳过；文本缓存仅变化时写 DOM，避免每帧 innerHTML 触发布局
  const label = $('hotspot-label')
  let lastLabelText = ''
  const tick = () => {
    if (scene && scene.getMode?.() === 'scene') {
      const center = scene.getActiveCenter?.()
      const route = INSPECTION_ROUTES[currentRouteIndex]
      if (center && route && route.focus?.type !== 'none') {
        const p = scene.projectToScreen(center)
        if (p.visible) {
          label.style.display = 'block'
          label.style.left = `${Math.round(p.x)}px`
          label.style.top = `${Math.round(p.y - 14)}px`
          const text = `<b>${String(route.order).padStart(2, '0')}</b> ${route.shortName}`
          if (text !== lastLabelText) { label.innerHTML = text; lastLabelText = text }
        } else if (label.style.display !== 'none') { label.style.display = 'none' }
      } else if (label.style.display !== 'none') { label.style.display = 'none' }
    } else if (label.style.display !== 'none') {
      // 漫游/检视：隐藏部位标注牌
      label.style.display = 'none'
    }
    requestAnimationFrame(tick)
  }
  tick()
  window.addEventListener('beforeunload', saveState)

  // 软键盘安全区（skill 约束 7）：监听 visualViewport，写入 CSS 变量
  // 使输入框在软键盘弹出后仍位于可见区域
  const vv = window.visualViewport
  if (vv) {
    const updateVh = () => {
      const root = document.documentElement
      root.style.setProperty('--vvh', `${vv.height}px`)
      root.style.setProperty('--vv-top', `${vv.offsetTop}px`)
    }
    vv.addEventListener('resize', updateVh)
    vv.addEventListener('scroll', updateVh)
    updateVh()
  }

  // 调试/自动化句柄
  window.__scene = scene
  if (new URLSearchParams(location.search).has('browser-test')) {
    let lastTestStation = null
    let lastTestPoint = null
    window.__inspectionTest = {
      openFirstFaultReport() {
        const point = scene.getInspectionPoints().find((entry) => entry.isPartPoint && !entry.isStationPoint && firstFaultType(entry))
        const station = scene.getStationPoints().find((entry) => entry.stationParts?.includes(point))
        if (!point || !station) return null
        lastTestStation = station
        lastTestPoint = point
        const normal = point.surfaceNormal?.clone?.() ?? { toArray: () => [0, 0, point.part?.side === 'right' ? 1 : -1] }
        const position = point.surfaceAnchor?.clone?.() ?? point.position.clone()
        let seeded = savePeerScenario(createPeerScenario({ name: '浏览器测试出题人', id: 'TEST-AUTHOR' }))
        seeded = upsertScenarioFault(seeded, {
          faultId: `F-TEST-${point.id}`,
          pointId: point.id, partId: point.part?.partId ?? '', itemId: point.itemId,
          stationId: station.id, faultType: firstFaultType(point),
          anchor: { position: position.toArray(), normal: normal.toArray(), tangent: [1, 0, 0] },
          glyph: { size: 0.072 },
        })
        peerScenario = markPeerScenarioAnswering(lockPeerScenario(seeded))
        state.profile.mode = 'peer'
        scene.configureScenario('peer', peerScenario)
        updatePeerSubmitButton()
        if (!scene.enterPointForTest(station)) return null
        const marker = point.markers.find((entry) => !entry.found)
        if (!marker) return null
        const panelBeforeMarker = getComputedStyle($('inspect-panel')).display
        const edgeBeforeMarker = getComputedStyle($('inspect-edge-exit')).display
        onMarkerPick(marker, point)
        return { pointId: point.id, stationId: station.id, faultType: marker.faultType, panelBeforeMarker, edgeBeforeMarker }
      },
      getEndpointReportSchema() {
        const point = scene.getInspectionPoints().find((entry) => entry.id === 'coupler-5')
        const marker = point?.markers?.[0] ?? { faultType: 'leak' }
        if (!point) return null
        const expected = expectedFaultReport(point, marker)
        configureFaultReportForm(expected)
        const visible = Array.from(document.querySelectorAll('[data-report-field]'))
          .filter((entry) => !entry.hidden)
          .map((entry) => entry.dataset.reportField)
        const aliasScore = scoreFaultReport({
          locomotive: 'HXD3D 0004', end: expected.end, side: '', axle: '', position: '',
          partName: '风管', innerOuter: '', faultType: expected.faultType,
        }, expected).score
        Array.from(document.querySelectorAll('[data-report-field]')).forEach((entry) => { entry.hidden = false })
        return { visible, expected, aliasScore }
      },
      currentView() {
        return {
          sceneMode: scene.getMode(),
          panel: getComputedStyle($('inspect-panel')).display,
          form: getComputedStyle($('fault-report-form')).display,
          edgeExit: getComputedStyle($('inspect-edge-exit')).display,
          appInspect: $('app').classList.contains('mode-inspect'),
        }
      },
      routeGuides() {
        return scene.getRouteGuideStats?.() ?? null
      },
      seedTwoFaultsOnOnePart() {
        const point = scene.getInspectionPoints().find((entry) => entry.isPartPoint && !entry.isStationPoint && firstFaultType(entry))
        const station = scene.getStationPoints().find((entry) => entry.stationParts?.includes(point))
        if (!point || !station) return null
        const base = point.surfaceAnchor?.clone?.() ?? point.position.clone()
        const normal = point.surfaceNormal?.clone?.() ?? base.clone().set(0, 0, point.part?.side === 'right' ? 1 : -1)
        const tangent = new point.position.constructor(1, 0, 0)
        let scenario = savePeerScenario(createPeerScenario({ name: '多故障测试', id: 'TEST-MULTI' }))
        for (let index = 0; index < 2; index += 1) {
          scenario = upsertScenarioFault(scenario, {
            faultId: `F-TEST-MULTI-${index + 1}`,
            pointId: point.id, partId: point.part?.partId ?? '', itemId: point.itemId,
            stationId: station.id, faultType: firstFaultType(point),
            anchor: {
              position: base.clone().addScaledVector(tangent, index * 0.09).toArray(),
              normal: normal.toArray(), tangent: tangent.toArray(),
            },
            glyph: { size: 0.062 },
          })
        }
        peerScenario = scenario
        scene.configureScenario('author', scenario)
        return {
          pointId: point.id,
          stored: scenario.faults.filter((fault) => fault.pointId === point.id).length,
          rendered: point.markers.length,
          faultIds: point.markers.map((marker) => marker.faultId),
        }
      },
      async placeTwoEndpointFaultsByPointer() {
        // 不直接写题目数据：真正进入端部复合站位，再向 Canvas 发送两次点击。
        // 用于回归用户报告的“排障器能点、风管不能点”真实交互链。
        const station = scene.getStationPoints().find((entry) => entry.id === 'station-pilot-front')
        const pilot = station?.stationParts?.find((entry) => entry.part?.type === 'pilot')
        const hose = station?.stationParts?.find((entry) => entry.id === 'coupler-5')
        if (!station || !pilot || !hose) return { error: 'endpoint-targets-missing' }
        scene.enterPointForTest(station)
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const canvas = scene.renderer.domElement
        const clickPoint = async (point, pointerId, screenOverride = null) => {
          const anchor = point.surfaceAnchor?.clone?.()
            ?? point.authoringBox?.getCenter?.(point.position.clone())
            ?? point.position.clone()
          const rect = canvas.getBoundingClientRect()
          const screen = screenOverride ?? scene.projectToScreen(anchor)
          const init = {
            bubbles: true, cancelable: true, pointerId, pointerType: 'touch', isPrimary: true,
            button: 0, buttons: 1, clientX: rect.left + screen.x, clientY: rect.top + screen.y,
          }
          canvas.dispatchEvent(new PointerEvent('pointerdown', init))
          canvas.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }))
          await new Promise((resolve) => requestAnimationFrame(resolve))
          return { pointId: point.id, screen, visible: screen.visible }
        }
        const first = await clickPoint(pilot, 71)
        const second = await clickPoint(hose, 72)
        const stored = peerScenario?.faults?.filter((fault) => [pilot.id, hose.id].includes(fault.pointId)) ?? []
        return {
          stationId: station.id,
          stationTargets: station.stationParts.map((entry) => entry.id),
          clicks: [first, second],
          stored: stored.length,
          pointIds: stored.map((fault) => fault.pointId),
          faultTypes: stored.map((fault) => fault.faultType),
          rendered: scene.getMarkersForPoint(station).filter((marker) => [pilot.id, hose.id].includes(marker.line?.userData?.pointId)).length,
        }
      },
      reenterLastStation() {
        if (!lastTestStation) return null
        const entered = scene.enterPointForTest(lastTestStation)
        return {
          entered,
          stationId: lastTestStation.id,
          sceneMode: scene.getMode(),
          panel: getComputedStyle($('inspect-panel')).display,
          edgeExit: getComputedStyle($('inspect-edge-exit')).display,
        }
      },
      lastReportedPointStatus() {
        if (!lastTestPoint) return null
        const itemId = lastTestPoint.itemId ?? lastTestPoint.item?.id
        const item = state.items[itemId]
        return {
          itemId, pointId: lastTestPoint.id,
          status: item?.partRecords?.[lastTestPoint.id]?.status ?? null,
          itemKeys: Object.keys(state.items),
          partKeys: Object.keys(item?.partRecords ?? {}),
        }
      },
    }
  }
}

init()
