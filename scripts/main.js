/**
 * 机车检查作业系统 V3 —— 主交互
 * ---------------------------------------------------------------------------
 * 三种模式：
 *   scene   场景：OrbitControls 观察整车 + 部位定位 + 检查项勾选
 *   roam    漫游：人视角走动（碰撞/跳跃/下蹲），靠近检查点按 E 交互
 *   inspect 检视：相机聚焦放大检查点，旋转视角找故障标记 → 填报故障活件
 *
 * 移动端：固定方向摇杆 + 独立按键（交互/加速/跳跃/下蹲）
 * 原孪生平台模型：只读不改不裁剪，检查内容以"检查点 + 故障标记"叠加
 */
import {
  INSPECTION_META,
  INSPECTION_ROUTES as ALL_INSPECTION_ROUTES,
  METHOD_LABELS,
  LEVEL_LABELS,
} from './inspectionData.js'
import { createInspectionScene } from './sceneController.js'
import { FAULT_TYPES, matchFaultType } from './partInspection.js'
import { getRunningGearItemIds, getRunningGearParts } from './parts/runningGearParts.js'
import { createInspectionFlow } from './inspectionFlow.js'
import { computeScore } from './scoring.js'

const STORAGE_KEY = 'hxd3d-inspection-underframe-record-v1'
const RING_LENGTH = 125.6
/** 当前只开放可在车外完成的检查：走行部、车钩连接、端部外观与信号。 */
const ACTIVE_ROUTE_IDS = new Set(['bogie', 'coupler', 'signal'])
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
  startTime: '',
  items: {}, // itemId -> { status, note, action, level, time, faultsFound, faultsTotal }
}
let currentRouteIndex = 0
let scene = null
let expandedAll = false
let modelSourceLabel = '加载中'
let activePoint = null       // 当前检视的检查点
let pendingMarker = null     // 待判定的故障标记
let preInspectMode = 'scene' // 进入检视前的模式（退出时返回）
let contextItemId = null     // 漫游中当前靠近/正在检视的部件，只在右侧展示它的要点

// 检查流程显式状态机（skill 约束 1）：阶段推进 + 完成判定
const flow = createInspectionFlow(INSPECTION_ROUTES, {
  isItemJudged: (id) => state.items[id]?.status ?? null,
})

// ───────────────────────── 存档 ─────────────────────────
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.items === 'object') { state = { ...state, ...parsed }; return true }
  } catch {}
  return false
}
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch {}
}
function resetState() {
  state = { sessionId: `JC${Date.now().toString().slice(-8)}`, operator: state.operator, startTime: formatNow(), items: {} }
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
  let found = 0, total = 0
  INSPECTION_ROUTES.forEach((r) => {
    r.items.forEach((i) => {
      const rec = state.items[i.id]
      if (rec?.faultsTotal) { found += rec.faultsFound ?? 0; total += rec.faultsTotal }
    })
  })
  return { found, total, rate: total ? found / total : 0 }
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
    state.items[item.id] = { ...(state.items[item.id] ?? {}), status: action, time: formatNow() }
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
  $('roam-hint').style.display = mode === 'roam' ? 'block' : 'none'
  $('inspect-panel').style.display = mode === 'inspect' ? 'flex' : 'none'

  // 先切场景状态（roam 时 enable playerController），再处理鼠标锁定
  scene?.setMode?.(mode)

  if (mode === 'roam') {
    const isTouch = scene?.isTouch() ?? false
    $('roam-hint-detail').textContent = isTouch
      ? '左摇杆移动 · 右半屏拖拽转视角 · 交互/加速/跳跃/下蹲'
      : 'WASD 移动 · 空格跳跃 · Shift 奔跑 · C 下蹲 · E 交互 · Esc 退出漫游'
    $('touch-controls').style.display = isTouch ? 'block' : 'none'
  } else {
    $('touch-controls').style.display = 'none'
    // 非漫游模式（场景/检视）释放鼠标锁定，让用户能点击面板/按钮
    scene?.releasePlayerLock?.()
  }
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
  setContextItem(point.itemId ?? point.item?.id)
  pendingMarker = null
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
    // 升弓电气检查（车外安全确认）：无三维故障标记，直接做安全确认
    $('inspect-title').textContent = '升弓电气检查（车外安全确认）'
    $('inspect-hint').textContent =
      '确认：①车顶无人 ②接触网无异物 ③接地线已挂 ④受电弓及车顶高压设备状态良好'
    $('inspect-wait').style.display = 'none'
    $('fault-report-form').style.display = 'none'
    $('inspect-progress').textContent = '安全确认'
    const st = $('inspect-status')
    st.textContent = '请完成车外安全确认'
    st.className = 'inspect-status'
    return
  }
  $('inspect-title').textContent = `${point.route.shortName} · ${point.item.name}`
  $('inspect-hint').textContent = '拖动旋转视角寻找标记；点击标记直接填报故障'
  updateInspectProgress()
  // 故障符号说明暂时保留在 DOM 中，当前训练界面不显示。
  $('inspect-wait').style.display = 'none'
  $('fault-report-form').style.display = 'none'
}

function updateInspectProgress() {
  if (!activePoint) return
  const total = activePoint.markers.length
  const found = activePoint.markers.filter((m) => m.found).length
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
  const part = point.part
  $('report-locomotive').value ||= 'HXD3D 0004'
  $('report-end').value = part?.endLabel ?? (point.position?.x > 4.2 ? 'I端' : 'II端')
  $('report-side').value = part?.side === 'left' ? '左侧' : part?.side === 'right' ? '右侧' : ''
  $('report-axle').value = part?.axleNo ? `${part.axleNo}轴` : ''
  $('report-position').value = ['前位', '中位', '后位'].includes(part?.positionLabel) ? part.positionLabel : ''
  $('report-part').value = part?.shortName ?? point.reportPartName ?? point.item?.name ?? ''
  $('report-inner-outer').value = part?.side === 'left' || part?.side === 'right' ? '外侧' : ''
  $('report-fault-type').value = ''
  $('fault-report-form').style.display = 'grid'
  $('report-end').focus()
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

function submitFaultReport(event) {
  event?.preventDefault?.()
  if (!pendingMarker || !activePoint) { showToast('请先点击三维画面中的故障标记'); return }
  const end = normalizeEnd($('report-end').value)
  const side = $('report-side').value
  const axleRaw = $('report-axle').value.trim()
  const axle = axleRaw ? normalizeAxle(axleRaw) : ''
  const partName = $('report-part').value.trim()
  const faultType = $('report-fault-type').value
  if (!end) { showToast('“哪节车或哪端”请填写 I端/II端、1端/2端或一端/二端'); return }
  if (!side) { showToast('请选择左侧或右侧（以司机 I 端方向为准）'); return }
  if (axleRaw && !axle) { showToast('轴号仅支持 1—6 或对应中文、罗马数字'); return }
  if (!partName) { showToast('请填写部件名称'); return }
  if (!faultType) { showToast('请选择故障类型'); return }

  const matched = matchFaultType(faultType, pendingMarker.faultType)
  if (!matched.matched) {
    showFeedback(false, '符号判断不符', '请按白线、白片、白环、红片、白叉或白三角的含义重新判断')
    return
  }
  const report = {
    locomotive: $('report-locomotive').value.trim(), end, side, axle,
    position: $('report-position').value, partName,
    innerOuter: $('report-inner-outer').value,
    faultType, faultLabel: FAULT_TYPES[faultType].label,
  }
  scene?.markFound?.(pendingMarker)
  if (activePoint.isPartPoint) {
    scene?.getPartFSM?.()?.observeMarker(activePoint.part.partId, `${activePoint.id}:${pendingMarker.faultType}`)
  }
  recordFaultFound(activePoint, report)
  showFeedback(true, '故障已上报', composeFaultReport(report))
  pendingMarker = null
  $('fault-report-form').style.display = 'none'
  updateInspectProgress()
  refreshProgress()
  renderRouteList()
  exitInspect()
}

function composeFaultReport(report) {
  return [report.locomotive, report.end, report.side, report.axle, report.position,
    report.partName, report.innerOuter, report.faultLabel].filter(Boolean).join('，')
}

function recordFaultFound(point, report) {
  const item = point.item
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
  r.faultReports = [...(r.faultReports ?? []), report]
  r.note = r.faultReports.map(composeFaultReport).join('；')
  r.action = '报修临修'
  r.level = '立即处理'
  r.time = formatNow()
  state.items[item.id] = r
  if (point.isPartPoint && found >= total) {
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
  if (activePoint?.isPartPoint) {
    scene?.getPartFSM?.()?.cancelInspect(activePoint.part.partId)
  }
  activePoint = null
  pendingMarker = null
  $('fault-report-form').style.display = 'none'
  $('inspect-reference').style.display = 'none'
  setContextItem(null)
  $('inspect-panel').style.display = 'none'
  // 返回进入检视前的模式（漫游或场景）
  setMode(preInspectMode)
}

/** 检视面板内直接记录合格/异常，闭环 8 步状态机（移动端友好） */
function decideFromInspect(action) {
  if (!activePoint) return
  const foundMarkers = activePoint.markers?.filter((m) => m.found).length ?? 0
  if (foundMarkers > 0) {
    showToast('本部件已上报故障，不能再确认未见异常')
    return
  }
  // 环节入口点（升弓电气检查车外点）：一次性确认整个 roof 环节（roof-1~5）
  if (activePoint.isRouteEntry) {
    const route = activePoint.route
    route.items.forEach((it) => {
      state.items[it.id] = { ...(state.items[it.id] ?? {}), status: action, time: formatNow() }
    })
    saveState()
    showToast(action === 'ok' ? '已确认升弓电气检查合格' : '已登记升弓电气检查异常')
    refreshProgress(); renderRouteList(); renderRouteDetail()
    exitInspect()
    return
  }
  const item = activePoint.item
  const prev = state.items[item.id] ?? {}
  const partRecords = {
    ...(prev.partRecords ?? {}),
    [activePoint.id]: {
      status: action,
      faultsTotal: activePoint.markers?.length ?? 0,
      faultsFound: foundMarkers,
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
  saveState()
  // 同步 FSM 运行时（走行部零部件）
  const fsm = scene?.getPartFSM?.()
  if (fsm && activePoint.isPartPoint) {
    fsm.judge(activePoint.part.partId, { status: action })
  }
  showToast(action === 'ok' ? `已确认合格：${item.name}` : `已登记异常：${item.name}`)
  refreshProgress()
  renderRouteList()
  renderRouteDetail()
  exitInspect()
}

// ───────────────────────── 结果汇总 ─────────────────────────
function renderReport() {
  const g = globalStats()
  const f = faultStats()
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
  $('report-note').innerHTML =
    `检查人：${state.operator} · 开始时间：${state.startTime}<br>${INSPECTION_META.disclaimer}`

  const score = computeScore({
    routes: INSPECTION_ROUTES,
    getItem: (id) => state.items[id],
    globalStats: g,
    faultStats: f,
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

function initMobileFullscreen() {
  const button = $('mobile-fullscreen')
  if (!button) return
  button.addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.()
      else await document.exitFullscreen?.()
      if (screen.orientation?.lock && !document.fullscreenElement) return
      await screen.orientation?.lock?.('landscape').catch(() => {})
    } catch {
      showToast('当前浏览器未允许全屏，请使用浏览器菜单进入全屏')
    }
  })
}

// ───────────────────────── 启动 ─────────────────────────
function init() {
  // 手机端标记（用于横屏 CSS 规则与安全区适配）
  const isCoarse = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window
    || new URLSearchParams(location.search).get('mobile') === '1'
  if (isCoarse) document.body.classList.add('mobile-controls-enabled')

  const restored = loadState()
  if (!state.sessionId) {
    state.sessionId = `JC${Date.now().toString().slice(-8)}`
    state.startTime = formatNow()
    saveState()
  }
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
  $('btn-report').addEventListener('click', renderReport)
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
  $('inspect-exit').addEventListener('click', exitInspect)
  $('fault-report-form').addEventListener('submit', submitFaultReport)
  $('fault-report-cancel').addEventListener('click', () => {
    pendingMarker = null
    $('fault-report-form').style.display = 'none'
  })
  // 未点击故障标记时只保留“确认未见异常”。
  $('inspect-ok').addEventListener('click', () => decideFromInspect('ok'))
  // Esc 退出检视（桌面端）
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && scene?.getMode?.() === 'inspect') {
      e.preventDefault()
      exitInspect()
    }
  })

  initVirtualJoystick()
  initVirtualButtons()
  initMobileFullscreen()

  scene = createInspectionScene($('three-host'), {
    onProgress: (r) => {
      const p = Math.round(r * 100)
      $('loading-bar').style.width = `${Math.max(4, p)}%`
      $('loading-text').textContent = `正在加载三维模型 · ${p}%`
    },
    onModelSource: (s) => {
      modelSourceLabel = s === 'local' ? '本地副本' : '引用孪生平台'
      $('foot-model').textContent = modelSourceLabel
    },
    onLoaded: () => {
      window.__sceneReady = true
      $('loading').style.display = 'none'
      scene.buildPoints(INSPECTION_ROUTES)
      const pts = scene.getInspectionPoints()
      $('foot-point').textContent = `${pts.length} 个`
      refreshProgress()
      selectRoute(currentRouteIndex, { focus: false })
      if (restored) showToast('已恢复上次未完成的检查记录')
      // ★ 默认直接进入漫游模式（第一人称视角），点击画面锁定鼠标
      setMode('roam')
      showToast('漫游模式：点击画面锁定鼠标 · WASD 移动 · E 检视部件')
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
      if (!desc) { hint.style.display = 'none'; return }
      hint.style.display = 'block'
      hint.classList.toggle('can-enter', Boolean(desc.canEnter))
      const name = desc.shortName || desc.name || '检查部位'
      if (desc.kind === 'part') {
        // 走行部：明确显示「部件名称 + 距离 + 交互条件」
        $('near-hint-text').textContent = `${name} · ${desc.distance.toFixed(1)} m`
        const sub = hint.querySelector('small')
        if (sub) {
          sub.textContent = desc.canEnter
            ? '按 E / 交互键进入检视'
            : `交互条件：${desc.unmetLabel || desc.stageLabel}`
        }
      } else {
        $('near-hint-text').textContent = `${name} · ${(desc.distance ?? 0).toFixed(1)} m`
        const sub = hint.querySelector('small')
        if (sub) sub.textContent = desc.routeEntry ? '按 E / 交互键 · 升弓电气检查' : '按 E / 交互键检视'
      }
    },
    onInspectEnter: (point) => {
      // 漫游按 E 进入检视时，sceneController 内部已切到 inspect，
      // 但 UI 层（面板显示/释放鼠标锁定/记录返回模式）需要这里同步。
      setMode('inspect')
      onInspectEnter(point)
    },
    onInspectExit: () => { activePoint = null; pendingMarker = null },
    onMarkerPick: (marker, point) => onMarkerPick(marker, point),
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
}

init()
