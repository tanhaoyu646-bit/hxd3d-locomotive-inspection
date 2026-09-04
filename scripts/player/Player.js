import * as THREE from 'three'

export const PLAYER_CONFIG = Object.freeze({
  eyeHeight: 1.75,
  crouchEyeHeight: 1.05,
  crouchSpeed: 1.1,
  crouchTransition: 12,
  walkSpeed: 1.7,
  runSpeed: 5.5,
  jumpSpeed: 5.2,
  gravity: -14,
  acceleration: 16,
  deceleration: 14,
  groundY: 0,
  // 从车体侧面检查站位开始，避免在车钩正前方直冲碰撞体而产生“卡死”感。
  spawnSideDistance: 4.2,
  spawnLongitudinalOffsetRatio: 0.26,
  initialLookHeightRatio: 0.24,
  maxDeltaTime: 0.05,
})

export class Player {
  constructor(config = PLAYER_CONFIG) {
    this.position = new THREE.Vector3(0, config.groundY, 0)
    this.velocity = new THREE.Vector3()
    this.movementState = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      run: false,
      jump: false,
      crouch: false,
    }
    this.grounded = true
    this.jumpRequested = false
    this.eyeHeight = config.eyeHeight
    this.standingEyeHeight = config.eyeHeight
    this.crouchEyeHeight = config.crouchEyeHeight
    this.crouchSpeed = config.crouchSpeed
    this.walkSpeed = config.walkSpeed
    this.runSpeed = config.runSpeed
  }

  clearMovement() {
    Object.keys(this.movementState).forEach((key) => {
      this.movementState[key] = false
    })
    this.velocity.set(0, 0, 0)
    this.jumpRequested = false
  }
}
