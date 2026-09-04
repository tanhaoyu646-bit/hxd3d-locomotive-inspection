/**
 * 双输入控制器 —— 桌面 PointerLock+WASD / 移动端虚拟摇杆
 * ---------------------------------------------------------------------------
 * 复用原平台 PlayerController 的物理手感与移动状态机，
 * 但解耦输入源：桌面端走键盘事件，移动端走虚拟摇杆/按键 emit。
 *
 * 暴露给外部：
 *   · setVirtualVector(vec)   移动端摇杆输入 (x:左右, y:前后)，范围 [-1,1]
 *   · setVirtualButton(name, pressed)  移动端按键（interact / jump / crouch / run）
 *   · requestLock() / unlock() 桌面端进入/退出鼠标锁定
 *   · update(dt)              每帧物理推进
 */
import * as THREE from 'three'
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js'
import { Player, PLAYER_CONFIG } from './Player.js'

const VIRTUAL_BUTTONS = ['forward', 'backward', 'left', 'right', 'run', 'jump', 'crouch', 'interact']

export class DualPlayerController {
  constructor({
    camera,
    domElement,
    collisionResolver = null,
    config = PLAYER_CONFIG,
    onLockChange,
    onPointerLockError,
    onInteract,
    onLookDelta, // 移动端拖拽转视角回调 (dx, dy)
  }) {
    this.camera = camera
    this.domElement = domElement
    this.config = { ...PLAYER_CONFIG, lookSpeed: 2.4, ...config }
    this.player = new Player(this.config)
    this.collisionResolver = collisionResolver
    this.onLockChange = onLockChange
    this.onPointerLockError = onPointerLockError
    this.onInteract = onInteract
    this.onLookDelta = onLookDelta
    this.enabled = false
    this.disposed = false
    this.isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window
      || new URLSearchParams(location.search).get('mobile') === '1'

    // 桌面端 PointerLockControls
    this.controls = new PointerLockControls(camera, domElement)
    this.controls.minPolarAngle = THREE.MathUtils.degToRad(5)
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(175)

    // 移动端视角增量累积，update 中应用
    this.lookDelta = { x: 0, y: 0 }
    this.lookVec = { x: 0, y: 0 }   // 保留程序化视角输入；手机当前使用右半屏拖拽
    this.yaw = 0
    this.pitch = 0
    this._reusableForward = new THREE.Vector3()
    this._reusableRight = new THREE.Vector3()
    this._moveDir = new THREE.Vector3()
    this._desiredVel = new THREE.Vector3()
    this._desiredPos = new THREE.Vector3()

    // 输入状态合并：键盘 + 虚拟按键
    this.input = {
      forward: false, backward: false, left: false, right: false,
      run: false, jump: false, crouch: false, interact: false,
    }
    this.virtualVec = { x: 0, y: 0 } // 摇杆 [-1,1]
    this._virtualButtons = {}

    // 桌面端键盘
    this.handleKeyDown = (e) => this._setKey(e.code, true, e)
    this.handleKeyUp = (e) => this._setKey(e.code, false, e)
    this.handleBlur = () => this._clearInput()
    this.handleVisibility = () => { if (document.hidden) this._clearInput() }
    this.handleLock = () => {
      this._clearInput()
      this.onLockChange?.(true)
    }
    this.handleUnlock = () => {
      this._clearInput()
      this.onLockChange?.(false)
    }
    this.handlePointerLockError = () => {
      this._clearInput()
      this.onPointerLockError?.({ code: 'POINTER_LOCK_ERROR', message: '浏览器拒绝鼠标锁定' })
    }

    window.addEventListener('keydown', this.handleKeyDown)
    window.addEventListener('keyup', this.handleKeyUp)
    window.addEventListener('blur', this.handleBlur)
    document.addEventListener('visibilitychange', this.handleVisibility)
    this.domElement.ownerDocument.addEventListener('pointerlockerror', this.handlePointerLockError)
    this.controls.addEventListener('lock', this.handleLock)
    this.controls.addEventListener('unlock', this.handleUnlock)

    // 移动端拖拽转视角
    this._touchLook = { active: false, lastX: 0, lastY: 0, id: null }
    this.domElement.addEventListener('touchstart', this._onTouchStart, { passive: false })
    this.domElement.addEventListener('touchmove', this._onTouchMove, { passive: false })
    this.domElement.addEventListener('touchend', this._onTouchEnd, { passive: false })
  }

  _KEY_MAP = {
    KeyW: 'forward', ArrowUp: 'forward',
    KeyS: 'backward', ArrowDown: 'backward',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right',
    ShiftLeft: 'run', ShiftRight: 'run',
    Space: 'jump',
    // 桌面端固定为 C 下蹲、E 交互，避免 Ctrl+数字键等浏览器快捷键冲突。
    KeyC: 'crouch',
    KeyE: 'interact',
  }

  _setKey(code, pressed, event) {
    const state = this._KEY_MAP[code]
    if (!state) return
    if (pressed && (!this.enabled || !this.controls.isLocked)) return
    this.input[state] = pressed
    if (state === 'jump' && pressed && !event.repeat && this.player.grounded && !this.input.crouch) {
      this.player.jumpRequested = true
    }
    if (state === 'interact' && pressed && !event.repeat) {
      this.onInteract?.()
    }
    if (this.controls.isLocked) event.preventDefault()
  }

  _clearInput() {
    Object.keys(this.input).forEach((k) => { this.input[k] = false })
    this.player.clearMovement()
    this.virtualVec = { x: 0, y: 0 }
    this._virtualButtons = {}
  }

  _onTouchStart = (e) => {
    if (!this.enabled) return
    // 右半屏拖拽转视角；左侧固定摇杆和右侧动作键拥有各自 pointer id。
    for (const t of e.changedTouches) {
      if (t.clientX < window.innerWidth * 0.5) continue
      // 排除虚拟动作按键上的触摸。
      const target = e.target
      if (target && target.closest && (target.closest('.vbtn') || target.closest('.view-joystick'))) continue
      this._touchLook.active = true
      this._touchLook.lastX = t.clientX
      this._touchLook.lastY = t.clientY
      this._touchLook.id = t.identifier
      break
    }
  }

  _onTouchMove = (e) => {
    if (!this._touchLook.active) return
    let t = null
    for (const ct of e.changedTouches) {
      if (ct.identifier === this._touchLook.id) { t = ct; break }
    }
    if (!t) return
    e.preventDefault()
    const dx = t.clientX - this._touchLook.lastX
    const dy = t.clientY - this._touchLook.lastY
    this._touchLook.lastX = t.clientX
    this._touchLook.lastY = t.clientY
    // 通过 PointerLockControls 内部的 _euler / _onMouseMove 不可直接调，
    // 这里直接修改相机欧拉角
    const sensitivity = 0.0042
    this.yaw -= dx * sensitivity
    this.pitch -= dy * sensitivity
    this.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, this.pitch))
  }

  _onTouchEnd = (e) => {
    for (const ct of e.changedTouches) {
      if (ct.identifier === this._touchLook.id) {
        this._touchLook.active = false
        this._touchLook.id = null
        break
      }
    }
  }

  /** 移动端摇杆输入 */
  setVirtualVector(x, y) {
    this.virtualVec.x = Math.max(-1, Math.min(1, x))
    this.virtualVec.y = Math.max(-1, Math.min(1, y))
  }

  /** 移动端右摇杆：视角增量输入（独立于整屏拖拽） */
  setLookVector(x, y) {
    this.lookVec.x = Math.max(-1, Math.min(1, x))
    this.lookVec.y = Math.max(-1, Math.min(1, y))
  }

  /** 移动端按键 */
  setVirtualButton(name, pressed) {
    if (!VIRTUAL_BUTTONS.includes(name)) return
    if (name === 'interact' && pressed && !this._virtualButtons.interact) {
      this.onInteract?.()
    }
    this._virtualButtons[name] = pressed
    if (name === 'jump' && pressed && this.player.grounded && !this.input.crouch) {
      this.player.jumpRequested = true
    }
  }

  get isLocked() {
    return this.isTouch ? this.enabled : this.controls.isLocked
  }

  enable() { this.enabled = true }
  disable() {
    this.enabled = false
    if (this.controls.isLocked) this.controls.unlock()
    this._clearInput()
  }

  requestLock() {
    if (!this.enabled || this.disposed) return false
    if (this.isTouch) return true // 移动端不需要 PointerLock
    if (typeof this.domElement.requestPointerLock !== 'function') {
      this.handlePointerLockError()
      return false
    }
    try { this.controls.lock() } catch { this.handlePointerLockError(); return false }
    return true
  }

  unlock() {
    if (this.controls.isLocked) this.controls.unlock()
  }

  setCollisionResolver(r) { this.collisionResolver = r }

  spawnFromBounds(bounds) {
    const size = bounds.getSize(new THREE.Vector3())
    const center = bounds.getCenter(new THREE.Vector3())
    const spawn = new THREE.Vector3(
      center.x + size.x * this.config.spawnLongitudinalOffsetRatio,
      this.config.groundY,
      bounds.max.z + this.config.spawnSideDistance,
    )
    this.player.position.copy(spawn)
    this.player.velocity.set(0, 0, 0)
    this.player.grounded = true
    this.player.jumpRequested = false
    this._syncCamera()
    const lookHeight = bounds.min.y + Math.min(this.player.eyeHeight, size.y * this.config.initialLookHeightRatio)
    const lookTarget = new THREE.Vector3(spawn.x, lookHeight, center.z)
    this.camera.lookAt(lookTarget)
    this.camera.updateMatrixWorld(true)
    // 初始化视角
    const dir = lookTarget.clone().sub(spawn)
    this.yaw = Math.atan2(dir.x, dir.z) + Math.PI
    this.pitch = 0
    return { spawn: spawn.clone(), lookTarget }
  }

  _getForward() {
    // 移动端用 yaw/pitch 推算方向；桌面端用 PointerLockControls.getDirection
    if (this.isTouch || !this.controls.isLocked) {
      this._reusableForward.set(
        Math.sin(this.yaw), 0, Math.cos(this.yaw),
      ).multiplyScalar(-1).normalize()
    } else {
      this.controls.getDirection(this._reusableForward)
      this._reusableForward.y = 0
      if (this._reusableForward.lengthSq() < 1e-8) this._reusableForward.set(0, 0, -1)
      else this._reusableForward.normalize()
    }
    this._reusableRight.crossVectors(this._reusableForward, this.camera.up).normalize()
    return { forward: this._reusableForward, right: this._reusableRight }
  }

  _calculateDesiredPosition(deltaTime) {
    // 合并键盘与虚拟按键
    const state = {
      forward: this.input.forward || this._virtualButtons.forward || this.virtualVec.y < -0.1,
      backward: this.input.backward || this._virtualButtons.backward || this.virtualVec.y > 0.1,
      left: this.input.left || this._virtualButtons.left || this.virtualVec.x < -0.1,
      right: this.input.right || this._virtualButtons.right || this.virtualVec.x > 0.1,
      run: this.input.run || this._virtualButtons.run,
      crouch: this.input.crouch || this._virtualButtons.crouch,
    }
    const analogForward = -this.virtualVec.y // 摇杆上推为前进
    const analogRight = this.virtualVec.x
    const forwardInput = state.forward ? 1 : state.backward ? -1 : analogForward
    const rightInput = state.right ? 1 : state.left ? -1 : analogRight
    const hasInput = Math.abs(forwardInput) > 0.05 || Math.abs(rightInput) > 0.05
    const speed = state.crouch
      ? this.player.crouchSpeed
      : state.run ? this.player.runSpeed : this.player.walkSpeed

    this._getForward()
    this._moveDir.set(0, 0, 0)
      .addScaledVector(this._reusableForward, forwardInput)
      .addScaledVector(this._reusableRight, rightInput)
    if (this._moveDir.lengthSq() > 1) this._moveDir.normalize()
    this._desiredVel.copy(this._moveDir).multiplyScalar(speed)

    const response = hasInput ? this.config.acceleration : this.config.deceleration
    const blend = 1 - Math.exp(-response * deltaTime)
    this.player.velocity.x = THREE.MathUtils.lerp(this.player.velocity.x, this._desiredVel.x, blend)
    this.player.velocity.z = THREE.MathUtils.lerp(this.player.velocity.z, this._desiredVel.z, blend)
    if (this.player.jumpRequested && this.player.grounded) {
      this.player.velocity.y = this.config.jumpSpeed
      this.player.grounded = false
    }
    this.player.jumpRequested = false
    if (!this.player.grounded) this.player.velocity.y += this.config.gravity * deltaTime

    this._desiredPos.copy(this.player.position).addScaledVector(this.player.velocity, deltaTime)
    if (this._desiredPos.y <= this.config.groundY) {
      this._desiredPos.y = this.config.groundY
      this.player.velocity.y = 0
      this.player.grounded = true
    }
    return this._desiredPos
  }

  update(deltaTime) {
    if (this.disposed) return
    const dt = Math.min(Math.max(deltaTime, 0), this.config.maxDeltaTime)
    const active = this.enabled && (this.isTouch || this.controls.isLocked) && dt > 0
    if (active) {
      const desired = this._calculateDesiredPosition(dt)
      let resolved = desired
      if (this.collisionResolver) {
        resolved = this.collisionResolver.resolve(
          this.player.position.clone(),
          desired.clone(),
          { velocity: this.player.velocity.clone(), deltaTime: dt, eyeHeight: this.player.eyeHeight, player: this.player },
        )
      }
      if (resolved?.isVector3) {
        if (Math.abs(resolved.x - desired.x) > 1e-6) this.player.velocity.x = 0
        if (Math.abs(resolved.z - desired.z) > 1e-6) this.player.velocity.z = 0
        this.player.position.copy(resolved)
      } else {
        this.player.position.copy(desired)
      }
      if (this.player.position.y <= this.config.groundY) {
        this.player.position.y = this.config.groundY
        this.player.velocity.y = 0
        this.player.grounded = true
      }
    }

    // 蹲下平滑过渡
    const targetEye = (this.input.crouch || this._virtualButtons.crouch) && this.player.grounded
      ? this.player.crouchEyeHeight : this.player.standingEyeHeight
    const crouchBlend = 1 - Math.exp(-this.config.crouchTransition * dt)
    this.player.eyeHeight = THREE.MathUtils.lerp(this.player.eyeHeight, targetEye, crouchBlend)

    // 移动端视角：直接设置欧拉角
    if (this.isTouch && this.enabled) {
      // 右摇杆视角输入：每帧按偏转量连续转动（lookSpeed 弧度/秒）
      if (this.lookVec.x || this.lookVec.y) {
        this.yaw -= this.lookVec.x * this.config.lookSpeed * dt
        this.pitch -= this.lookVec.y * this.config.lookSpeed * dt
        this.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, this.pitch))
      }
      this.camera.position.set(
        this.player.position.x,
        this.player.position.y + this.player.eyeHeight,
        this.player.position.z,
      )
      this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ')
    } else {
      this._syncCamera()
    }
  }

  _syncCamera() {
    this.camera.position.set(
      this.player.position.x,
      this.player.position.y + this.player.eyeHeight,
      this.player.position.z,
    )
  }

  /** 返回玩家到目标点的距离（用于触发交互） */
  distanceTo(point) {
    return this.player.position.distanceTo(point)
  }

  dispose() {
    if (this.disposed) return
    this.disable()
    this.disposed = true
    window.removeEventListener('keydown', this.handleKeyDown)
    window.removeEventListener('keyup', this.handleKeyUp)
    window.removeEventListener('blur', this.handleBlur)
    document.removeEventListener('visibilitychange', this.handleVisibility)
    this.domElement.ownerDocument.removeEventListener('pointerlockerror', this.handlePointerLockError)
    this.controls.removeEventListener('lock', this.handleLock)
    this.controls.removeEventListener('unlock', this.handleUnlock)
    this.domElement.removeEventListener('touchstart', this._onTouchStart)
    this.domElement.removeEventListener('touchmove', this._onTouchMove)
    this.domElement.removeEventListener('touchend', this._onTouchEnd)
    this.controls.dispose()
  }
}
