import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const url = process.argv[2] || 'http://127.0.0.1:8777/index.html?browser-test=1'
const variant = process.argv[3] || 'peer'
const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const port = 9335
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxd3d-browser-test-'))
const browser = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--window-size=1056,480',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  url,
], { stdio: 'ignore' })

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function getJson(endpoint) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`)
  if (!response.ok) throw new Error(`${endpoint} ${response.status}`)
  return response.json()
}
async function waitForTarget() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const pages = await getJson('/json')
      const page = pages.find((entry) => entry.type === 'page' && entry.url.startsWith(url.split('?')[0]))
      if (page?.webSocketDebuggerUrl) return page
    } catch {}
    await wait(125)
  }
  throw new Error('浏览器页面未启动')
}

let sequence = 0
const pending = new Map()
let socket
function cdp(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text)
  return response.result?.result?.value
}
async function waitFor(expression, label, attempts = 600) {
  for (let i = 0; i < attempts; i += 1) {
    if (await evaluate(expression)) return
    await wait(125)
  }
  throw new Error(`等待超时：${label}`)
}

let failed = 0
function check(label, condition, detail = '') {
  if (condition) console.log(`✓ ${label}${detail ? ` · ${detail}` : ''}`)
  else { failed += 1; console.error(`✗ ${label}${detail ? ` · ${detail}` : ''}`) }
}

try {
  const target = await waitForTarget()
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    const task = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) task.reject(new Error(message.error.message))
    else task.resolve(message)
  })
  await cdp('Runtime.enable')
  await waitFor('Boolean(window.__sceneReady)', '三维模型就绪')
  await waitFor("document.getElementById('session-gate')?.style.display === 'grid'", '登录界面显示')
  const entry = await evaluate(`(() => {
    document.getElementById('session-name').value = '浏览器流程测试'
    document.getElementById('session-id').value = 'TEST-A01'
    document.getElementById('session-mode').value = '${variant === 'single' ? 'practice' : 'author'}'
    document.getElementById('session-enter').click()
    return true
  })()`)
  check(variant === 'peer' ? '已触发同伴出题登录' : '已触发单人检查登录', entry === true)
  await waitFor("document.body.classList.contains('session-running')", '进入训练')
  const state = await evaluate(`(() => ({
    running: document.body.classList.contains('session-running'),
    gate: document.getElementById('session-gate').style.display,
    toolbar: document.getElementById('author-toolbar') ? getComputedStyle(document.getElementById('author-toolbar')).display : null,
    scenario: JSON.parse(localStorage.getItem('hxd3d-peer-scenario-v4') || 'null'),
    title: document.getElementById('title-sub').textContent,
  }))()`)
  check(variant === 'peer' ? '同伴出题模式能够进入' : '单人检查模式能够进入', state.running && state.gate === 'none')
  if (variant === 'peer') {
    check('出题工具栏已经显示', state.toolbar === 'flex', `display=${state.toolbar}`)
    check('新题目草稿已建立', state.scenario?.status === 'draft', `status=${state.scenario?.status}`)
    check('出题开始时没有任何预置故障', state.scenario?.faults?.length === 0, `faults=${state.scenario?.faults?.length}`)
  } else if (variant === 'single') {
    check('单人版未混入出题工具栏', state.toolbar === null)
  }
  check('页面载入当前修复版本', state.title.includes(variant === 'single' ? 'V1.6.0' : 'V1.7.0'), state.title)
  const ui = await evaluate(`(() => ({
    confirmText: document.querySelector('#fault-report-form .fault-submit')?.textContent.trim(),
    inspectClose: document.getElementById('inspect-exit')?.textContent.trim(),
    duplicateButtons: ['inspect-toggle','inspect-ok','fault-report-cancel'].filter((id) => document.getElementById(id)),
    viewport: [innerWidth, innerHeight],
    peerModes: Array.from(document.getElementById('session-mode')?.options ?? []).map((option) => option.value),
  }))()`)
  check('故障填报按钮统一为确定', ui.confirmText === '确定', ui.confirmText)
  check('部件检视仅保留独立叉号', ui.inspectClose === '×' && ui.duplicateButtons.length === 0)
  check('手机横屏比例测试视口生效', ui.viewport[0] > ui.viewport[1], ui.viewport.join('×'))
  if (variant !== 'single') check('同伴版登录只保留出题和答题', ui.peerModes.join(',') === 'author,peer', ui.peerModes.join(','))
  if (variant === 'report') {
    const picked = await evaluate('window.__inspectionTest?.openFirstFaultReport()')
    check('已进入带故障的零部件检视', Boolean(picked?.pointId), picked?.pointId)
    check('未点击故障前填报窗保持隐藏且仅显示独立退出键', picked?.panelBeforeMarker === 'none' && picked?.edgeBeforeMarker !== 'none',
      `${picked?.panelBeforeMarker}/${picked?.edgeBeforeMarker}`)
    check('点击假设性故障后填报窗口显示', Boolean(picked?.faultType), picked?.faultType)
    await waitFor("getComputedStyle(document.getElementById('fault-report-form')).display !== 'none'", '故障填报窗口')
    await wait(350)
    const layout = await evaluate(`(() => {
      const rect = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height} }
      const overlaps = (a,b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
      const mainExit = rect('mobile-exit'), panelExit = rect('inspect-exit'), panel = rect('inspect-panel')
      return { mainExit, panelExit, panel, viewportWidth:innerWidth, overlap:overlaps(mainExit,panelExit) }
    })()`)
    check('手机横屏下检视叉号不与主页面叉号重叠', !layout.overlap, JSON.stringify(layout))
    check('手机横屏填报窗不超过半屏', layout.panel.width <= layout.viewportWidth * .5, `${Math.round(layout.panel.width)}/${layout.viewportWidth}`)
    check('手机横屏填报窗和叉号完整位于可视区域', layout.panel.right <= layout.viewportWidth + 1 && layout.panelExit.right <= layout.viewportWidth + 1,
      JSON.stringify(layout))
    const submitted = await evaluate(`(() => {
      document.getElementById('report-end').value ||= 'I端'
      document.getElementById('report-side').value ||= '左侧'
      document.getElementById('report-part').value ||= '检查部件'
      const faultSelect = document.getElementById('report-fault-type')
      const deliberatelyWrong = Array.from(faultSelect.options).map((option) => option.value)
        .find((value) => value && value !== ${JSON.stringify(picked.faultType)})
      faultSelect.value = deliberatelyWrong
      document.getElementById('fault-report-form').requestSubmit()
      return { submitted:true, expected:${JSON.stringify(picked.faultType)}, selected:deliberatelyWrong }
    })()`)
    check('已用错误故障类型点击确定', submitted.submitted && submitted.expected !== submitted.selected,
      `${submitted.selected} / 正确 ${submitted.expected}`)
    await wait(250)
    const exited = await evaluate('window.__inspectionTest.currentView()')
    check('故障填报后关闭右侧窗口并退出零部件视图', exited.sceneMode !== 'inspect' && exited.panel === 'none' && exited.form === 'none' && exited.edgeExit === 'none' && !exited.appInspect,
      JSON.stringify(exited))
    const reentered = await evaluate('window.__inspectionTest.reenterLastStation()')
    check('同一标准站位填报后仍可重新进入', reentered?.entered && reentered.sceneMode === 'inspect' && reentered.panel === 'none' && reentered.edgeExit !== 'none',
      JSON.stringify(reentered))
  }
} catch (error) {
  failed += 1
  console.error(`✗ 浏览器流程检查异常 · ${error.message}`)
} finally {
  try { socket?.close() } catch {}
  browser.kill()
  await Promise.race([
    new Promise((resolve) => browser.once('exit', resolve)),
    wait(1500),
  ])
  const resolved = path.resolve(profileDir)
  if (resolved.startsWith(path.resolve(os.tmpdir()))) {
    try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch {}
  }
}

if (failed) process.exit(1)
