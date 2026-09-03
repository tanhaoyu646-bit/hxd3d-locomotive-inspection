/**
 * 双端口启动器 —— 同时开「电脑端」与「手机端」两个服务
 * ---------------------------------------------------------------------------
 *   电脑端 → 8777，绑定 127.0.0.1（仅本机，自动打开浏览器）
 *   手机端 → 8778，绑定 0.0.0.0（允许局域网访问，打印 IP 与二维码）
 *
 * 用法：node tools/serve-dual.js
 *       两个服务共用一个进程，Ctrl + C 一次全部退出。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVE = path.join(__dirname, 'serve.js')

const PC_PORT = 8777
const MOBILE_PORT = 8778

function start(args, tag) {
  const child = spawn(process.execPath, [SERVE, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const prefix = `[${tag}] `
  child.stdout.on('data', (buf) => {
    String(buf).split(/\r?\n/).forEach((line) => {
      if (line.trim()) console.log(prefix + line)
    })
  })
  child.stderr.on('data', (buf) => {
    String(buf).split(/\r?\n/).forEach((line) => {
      if (line.trim()) console.error(prefix + line)
    })
  })
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.log(`${prefix}进程退出，代码 ${code}`)
  })
  return child
}

console.log('')
console.log('  启动双端口服务：电脑端 ' + PC_PORT + ' / 手机端 ' + MOBILE_PORT)
console.log('')

const pc = start([String(PC_PORT)], '电脑端')
// 手机端稍晚启动，避免两条输出交错
const mobile = start([String(MOBILE_PORT), '--lan', '--no-open'], '手机端')

const children = [pc, mobile]
let shuttingDown = false

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log('')
  console.log('  正在关闭服务...')
  children.forEach((c) => { try { c.kill() } catch {} })
  setTimeout(() => process.exit(0), 400)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('exit', () => {
  children.forEach((c) => { try { c.kill() } catch {} })
})
