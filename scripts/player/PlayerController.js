import * as THREE from 'three'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'
import { Player, PLAYER_CONFIG } from './Player.js'

const KEY_TO_STATE = Object.freeze({
  KeyW: 'forward',
  KeyS: 'backward',
  KeyA: 'left',
  KeyD: 'right',
  ShiftLeft: 'run',
  ShiftRight: 'run',
  Space: 'jump',
  ControlLeft: 'crouch',
  ControlRight: 'crouch',
})

const PASSTHROUGH_COLLISION_RESOLVER = Object.freeze({
  resolve(_currentPosition, desiredPosition) {
    return desiredPosition
  },
})

export class PlayerController {
  constructor({
    camera,
    domElement,
    collisionResolver = PASSTHROUGH_COLLISION_RESOLVER,
    config = PLAYER_CONFIG,
    onLockChange,
    onPointerLockError,
    onStateChange,
  }) {
    this.camera = camera
    this.domElement = domElement
    this.config = { ...PLAYER_CONFIG, ...config }
    this.player = new Player(this.config)
    this.collisionResolver = collisionResolver
    this.onLockChange = onLockChange
    this.onPointerLockError = onPointerLockError
    this.onStateChange = onStateChange
    this.enabled = false
    this.disposed = false

    this.controls = new PointerLockControls(camera, domElement)
    this.controls.minPolarAngle = THREE.MathUtils.degToRad(5)
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(175)

    this.forward = new THREE.Vector3()
    this.right = new THREE.Vector3()
    this.moveDirection = new THREE.Vector3()
    this.desiredVelocity = new THREE.Vector3()
    this.desiredPosition = new THREE.Vector3()

    this.handleKeyDown = (event) => this.setKeyState(event, true)
    this.handleKeyUp = (event) => this.setKeyState(event, false)
    this.handleBlur = () => this.clearInput()
    this.handleVisibilityChange = () => {
      if (document.hidden) this.clearInput()
    }
    this.handlePointerLockError = () => {
      this.clearInput()
      this.onPointerLockError?.({
        code: 'POINTER_LOCK_ERROR',
        message: '当前浏览器环境拒绝鼠标锁定，请使用本地启动脚本在 Chrome 或 Edge 顶层页面中打开。',
      })
    }
    this.handleLock = () => {
      this.clearInput()
      this.onLockChange?.(true)
      this.emitState()
    }
    this.handleUnlock = () => {
      this.clearInput()
      this.onLockChange?.(false)
      this.emitState()
    }

    window.addEventListener('keydown', this.handleKeyDown)
    window.addEventListener('keyup', this.handleKeyUp)
    window.addEventListener('blur', this.handleBlur)
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    this.domElement.ownerDocument.addEventListener('pointerlockerror', this.handlePointerLockError)
    this.controls.addEventListener('lock', this.handleLock)
    this.controls.addEventListener('unlock', this.handleUnlock)
    this.syncCameraPosition()
  }

  get isLocked() {
    return this.controls.isLocked
  }

  enable() {
    this.enabled = true
    this.emitState()
  }

  disable() {
    this.enabled = false
    if (this.controls.isLocked) this.controls.unlock()
    this.clearInput()
    this.emitState()
  }

  requestLock() {
    if (!this.enabled || this.disposed) return false
    if (typeof this.domElement.requestPointerLock !== 'function') {
      this.handlePointerLockError()
      return false
    }
    try {
      this.controls.lock()
    } catch (error) {
      this.handlePointerLockError()
      console.error('[HXD3D] Pointer Lock 请求失败', error)
      return false
    }
    return true
  }

  unlock() {
    if (this.controls.isLocked) this.controls.unlock()
  }

  setCollisionResolver(collisionResolver) {
    this.collisionResolver = collisionResolver ?? PASSTHROUGH_COLLISION_RESOLVER
  }

  setKeyState(event, pressed) {
    const stateKey = KEY_TO_STATE[event.code]
    if (!stateKey) return

    if (pressed && (!this.enabled || !this.controls.isLocked)) return
    this.player.movementState[stateKey] = pressed
    if (stateKey === 'jump' && pressed && !event.repeat && this.player.grounded && !this.player.movementState.crouch) {
      this.player.jumpRequested = true
    }
    if (this.controls.isLocked) event.preventDefault()
  }

  clearInput() {
    this.player.clearMovement()
  }

  spawnFromBounds(bounds) {
    const size = bounds.getSize(new THREE.Vector3())
    const center = bounds.getCenter(new THREE.Vector3())
    const spawn = new THREE.Vector3(
      bounds.max.x + this.config.spawnSideDistance,
      this.config.groundY,
      center.z + size.z * this.config.spawnLongitudinalOffsetRatio,
    )

    this.player.position.copy(spawn)
    this.player.velocity.set(0, 0, 0)
    this.player.grounded = true
    this.player.jumpRequested = false
    this.syncCameraPosition()

    const lookHeight = bounds.min.y + Math.min(
      this.player.eyeHeight,
      size.y * this.config.initialLookHeightRatio,
    )
    const lookTarget = new THREE.Vector3(center.x, lookHeight, spawn.z)
    this.camera.lookAt(lookTarget)
    this.camera.updateMatrixWorld(true)
    this.emitState()

    return { spawn: spawn.clone(), lookTarget }
  }

  getHorizontalDirections() {
    this.controls.getDirection(this.forward)
    this.forward.y = 0
    if (this.forward.lengthSq() < 1e-8) this.forward.set(0, 0, -1)
    else this.forward.normalize()

    this.right.crossVectors(this.forward, this.camera.up).normalize()
    return { forward: this.forward, right: this.right }
  }

  calculateDesiredPosition(deltaTime) {
    const state = this.player.movementState
    const forwardInput = Number(state.forward) - Number(state.backward)
    const rightInput = Number(state.right) - Number(state.left)
    const hasInput = forwardInput !== 0 || rightInput !== 0
    const speed = state.crouch
      ? this.player.crouchSpeed
      : state.run
        ? this.player.runSpeed
        : this.player.walkSpeed

    this.getHorizontalDirections()
    this.moveDirection
      .set(0, 0, 0)
      .addScaledVector(this.forward, forwardInput)
      .addScaledVector(this.right, rightInput)

    if (this.moveDirection.lengthSq() > 1) this.moveDirection.normalize()
    this.desiredVelocity.copy(this.moveDirection).multiplyScalar(speed)

    const response = hasInput ? this.config.acceleration : this.config.deceleration
    const blend = 1 - Math.exp(-response * deltaTime)
    this.player.velocity.x = THREE.MathUtils.lerp(this.player.velocity.x, this.desiredVelocity.x, blend)
    this.player.velocity.z = THREE.MathUtils.lerp(this.player.velocity.z, this.desiredVelocity.z, blend)
    if (this.player.jumpRequested && this.player.grounded) {
      this.player.velocity.y = this.config.jumpSpeed
      this.player.grounded = false
    }
    this.player.jumpRequested = false
    if (!this.player.grounded) this.player.velocity.y += this.config.gravity * deltaTime

    this.desiredPosition
      .copy(this.player.position)
      .addScaledVector(this.player.velocity, deltaTime)
    if (this.desiredPosition.y <= this.config.groundY) {
      this.desiredPosition.y = this.config.groundY
      this.player.velocity.y = 0
      this.player.grounded = true
    }

    return this.desiredPosition
  }

  update(rawDeltaTime) {
    if (this.disposed) return

    const deltaTime = Math.min(Math.max(rawDeltaTime, 0), this.config.maxDeltaTime)
    if (this.enabled && this.controls.isLocked && deltaTime > 0) {
      const desiredPosition = this.calculateDesiredPosition(deltaTime)
      const resolvedPosition = this.collisionResolver === PASSTHROUGH_COLLISION_RESOLVER
        ? desiredPosition
        : this.collisionResolver.resolve(
          this.player.position.clone(),
          desiredPosition.clone(),
          {
            velocity: this.player.velocity.clone(),
            deltaTime,
            eyeHeight: this.player.eyeHeight,
            player: this.player,
          },
        )

      if (resolvedPosition?.isVector3) {
        if (Math.abs(resolvedPosition.x - desiredPosition.x) > 1e-6) this.player.velocity.x = 0
        if (Math.abs(resolvedPosition.z - desiredPosition.z) > 1e-6) this.player.velocity.z = 0
        this.player.position.copy(resolvedPosition)
      } else {
        this.player.position.copy(desiredPosition)
      }
      if (this.player.position.y <= this.config.groundY) {
        this.player.position.y = this.config.groundY
        this.player.velocity.y = 0
        this.player.grounded = true
      }
    }

    const targetEyeHeight = this.player.movementState.crouch && this.player.grounded
      ? this.player.crouchEyeHeight
      : this.player.standingEyeHeight
    const crouchBlend = 1 - Math.exp(-this.config.crouchTransition * deltaTime)
    this.player.eyeHeight = THREE.MathUtils.lerp(this.player.eyeHeight, targetEyeHeight, crouchBlend)
    this.syncCameraPosition()
  }

  syncCameraPosition() {
    this.camera.position.set(
      this.player.position.x,
      this.player.position.y + this.player.eyeHeight,
      this.player.position.z,
    )
  }

  getState() {
    return {
      enabled: this.enabled,
      isPointerLocked: this.controls.isLocked,
      mode: 'FIRST_PERSON',
      position: this.player.position.toArray(),
      velocity: this.player.velocity.toArray(),
      eyeHeight: this.player.eyeHeight,
      walkSpeed: this.player.walkSpeed,
      runSpeed: this.player.runSpeed,
      jumpSpeed: this.config.jumpSpeed,
      grounded: this.player.grounded,
      isRunning: this.player.movementState.run,
      isCrouching: this.player.movementState.crouch,
      movementState: { ...this.player.movementState },
    }
  }

  emitState() {
    this.onStateChange?.(this.getState())
  }

  dispose() {
    if (this.disposed) return
    this.disable()
    this.disposed = true
    window.removeEventListener('keydown', this.handleKeyDown)
    window.removeEventListener('keyup', this.handleKeyUp)
    window.removeEventListener('blur', this.handleBlur)
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    this.domElement.ownerDocument.removeEventListener('pointerlockerror', this.handlePointerLockError)
    this.controls.removeEventListener('lock', this.handleLock)
    this.controls.removeEventListener('unlock', this.handleUnlock)
    this.controls.dispose()
    this.clearInput()
  }
}
