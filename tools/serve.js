/**
 * 机车检查作业系统 —— 本地静态服务器
 * ---------------------------------------------------------------------------
 * 为什么必须用它：页面使用 ES Module，且三维模型（GLB）通过 fetch 加载。
 * 直接双击 index.html 以 file:// 打开时，浏览器会因同源策略拦截，
 * 导致模块与模型都无法加载。因此需要通过本脚本以 http:// 方式访问。
 *
 * 用法：
 *   node tools/serve.js [端口] [选项]
 *
 * 选项：
 *   --lan / --host 0.0.0.0   绑定全部网卡，允许手机等局域网设备访问，
 *                            并打印局域网 IP 与二维码（默认只监听 127.0.0.1）
 *   --no-open                启动后不自动打开浏览器
 *   --qr                     强制显示二维码（即使不是 --lan 模式）
 *
 * 默认端口 8777，根目录为「资源」文件夹（以便按相对路径引用原孪生平台模型）。
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exec } from 'node:child_process'
import { toTerminal } from './qrcode.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR_NAME = '机车检查作业'
const DEFAULT_PORT = 8777

// ── 参数解析 ──
const argv = process.argv.slice(2)
let port = DEFAULT_PORT
let host = '127.0.0.1'
let autoOpen = true
let showQr = false
let qrOverride = null

for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (/^\d+$/.test(a)) port = Number(a)
  else if (a === '--lan') { host = '0.0.0.0'; showQr = true }
  else if (a === '--host') { host = argv[++i] ?? '0.0.0.0'; showQr = true }
  else if (a === '--no-open') autoOpen = false
  else if (a === '--qr') showQr = true
}

/** 获取本机局域网 IPv4 地址列表 */
function getLanAddresses() {
  const list = []
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) list.push(net.address)
    }
  }
  return list
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/** 确定站点根目录：优先「资源」目录（含原孪生平台），否则回退到本应用目录 */
function resolveRoot() {
  const appDir = path.resolve(__dirname, '..')
  const parentDir = path.resolve(appDir, '..')
  const sharedModel = path.join(
    parentDir,
    '机车数字孪生',
    '01-系统程序（V1至V2.3）',
    'hxd3d-digital-twin',
    'public',
    'models',
    'hxd3d',
    'hxd3d-integration-spatial.glb',
  )
  if (path.basename(parentDir) === '资源' && fs.existsSync(sharedModel)) {
    return { root: parentDir, base: '', modelOk: true }
  }
  return { root: appDir, base: '', modelOk: false }
}

const { root, modelOk } = resolveRoot()

const server = http.createServer((req, res) => {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://localhost:${port}`).pathname)
  } catch {
    res.writeHead(400).end('Bad Request')
    return
  }
  if (pathname === '/' || pathname === '') {
    res.writeHead(302, { Location: `/${encodeURIComponent(APP_DIR_NAME)}/index.html` })
    res.end()
    return
  }

  const target = path.join(root, pathname)
  // 防目录穿越
  if (!target.startsWith(root)) {
    res.writeHead(403).end('Forbidden')
    return
  }

  fs.stat(target, (err, stats) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('404 Not Found: ' + pathname)
      return
    }
    if (stats.isDirectory()) {
      const indexPath = path.join(target, 'index.html')
      if (fs.existsSync(indexPath)) {
        res.writeHead(302, { Location: pathname.replace(/\/?$/, '/') + 'index.html' })
        res.end()
      } else {
        res.writeHead(404).end('404 Not Found')
      }
      return
    }
    const ext = path.extname(target).toLowerCase()
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stats.size,
      'Cache-Control': 'no-cache',
    })
    fs.createReadStream(target).pipe(res)
  })
})

server.listen(port, host, () => {
  const APP_PATH = `/${encodeURIComponent(APP_DIR_NAME)}/index.html`
  const localUrl = `http://localhost:${port}${APP_PATH}`
  const lanAddresses = host === '0.0.0.0' ? getLanAddresses() : []

  console.log('')
  console.log('  ╔══════════════════════════════════════════════════════╗')
  console.log('  ║   机车检查作业系统 —— 本地服务已启动                 ║')
  console.log('  ╚══════════════════════════════════════════════════════╝')
  console.log('')
  console.log('  端口       :', port)
  console.log('  监听       :', host === '0.0.0.0' ? '0.0.0.0（允许局域网设备访问）' : host + '（仅本机）')
  console.log('  站点根目录 :', root)
  console.log('  三维模型   :', modelOk ? '引用原孪生平台（可用）' : '未找到，将尝试本目录 models/ 下的副本')
  console.log('')
  console.log('  ── 访问地址 ──────────────────────────────────────────')
  console.log('  电脑端 :', localUrl)
  if (lanAddresses.length) {
    lanAddresses.forEach((ip) => {
      console.log('  手机端 :', `http://${ip}:${port}${APP_PATH}`)
    })
    console.log('')
    console.log('  （手机需与电脑连接同一个 Wi-Fi；若无法访问请检查系统防火墙）')
  }
  console.log('  ──────────────────────────────────────────────────────')
  console.log('')
  console.log('  关闭服务请在本窗口按 Ctrl + C')
  console.log('')

  // 手机端二维码
  if (showQr && lanAddresses.length) {
    const qrUrl = qrOverride ?? `http://${lanAddresses[0]}:${port}${APP_PATH}`
    console.log('  ── 手机扫码访问（' + lanAddresses[0] + '）──')
    try {
      console.log(toTerminal(qrUrl, { invert: true }))
    } catch (e) {
      console.log('  （二维码生成失败，请手动输入上面的手机端地址）')
    }
    console.log('')
  }

  if (autoOpen) {
    const command =
      process.platform === 'win32' ? `start "" "${localUrl}"`
        : process.platform === 'darwin' ? `open "${localUrl}"`
          : `xdg-open "${localUrl}"`
    exec(command, () => {})
  }
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用，请换一个端口：node tools/serve.js ${port + 1}`)
  } else if (error.code === 'EADDRNOTAVAIL') {
    console.error(`无法绑定到 ${host}，请检查网络接口。可去掉 --lan 参数仅本机访问。`)
  } else {
    console.error('服务启动失败：', error)
  }
  process.exit(1)
})
