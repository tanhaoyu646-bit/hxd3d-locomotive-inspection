import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const url = process.argv[2] || 'http://127.0.0.1:8777/index.html?browser-test=1'
const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const port = 9335
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxd3d-browser-test-'))
const browser = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
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
    document.getElementById('session-mode').value = 'author'
    document.getElementById('session-enter').click()
    return true
  })()`)
  check('已触发同伴出题登录', entry === true)
  await waitFor("document.body.classList.contains('session-running')", '进入训练')
  const state = await evaluate(`(() => ({
    running: document.body.classList.contains('session-running'),
    gate: document.getElementById('session-gate').style.display,
    toolbar: getComputedStyle(document.getElementById('author-toolbar')).display,
    mode: JSON.parse(localStorage.getItem('hxd3d-peer-scenario-v3') || 'null')?.status,
    title: document.getElementById('title-sub').textContent,
  }))()`)
  check('同伴出题模式能够进入', state.running && state.gate === 'none')
  check('出题工具栏已经显示', state.toolbar === 'flex', `display=${state.toolbar}`)
  check('新题目草稿已建立', state.mode === 'draft', `status=${state.mode}`)
  check('页面载入当前修复版本', state.title.includes('V1.5.0'), state.title)
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
