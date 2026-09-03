import * as THREE from 'three'

const DEFAULT_PLAYER_RADIUS = 0.38
const COLLISION_EPSILON = 1e-4

/**
 * Low-cost first-person collision against the locomotive's world-space AABB.
 * The player position represents the feet; eyeHeight defines the capsule height.
 * Horizontal axes are resolved separately so movement slides along the vehicle.
 */
export class LocomotiveCollisionResolver {
  constructor(bounds, { playerRadius = DEFAULT_PLAYER_RADIUS } = {}) {
    this.sourceBounds = bounds.clone()
    this.playerRadius = playerRadius
    this.expandedBounds = bounds.clone().expandByVector(new THREE.Vector3(playerRadius, 0, playerRadius))
    this.resolvedPosition = new THREE.Vector3()
    this.axisCandidate = new THREE.Vector3()
  }

  intersectsPlayer(position, eyeHeight) {
    const playerMinY = position.y
    const playerMaxY = position.y + Math.max(eyeHeight, 0.1)
    const verticalOverlap = playerMaxY > this.expandedBounds.min.y + COLLISION_EPSILON
      && playerMinY < this.expandedBounds.max.y - COLLISION_EPSILON
    if (!verticalOverlap) return false

    return position.x > this.expandedBounds.min.x + COLLISION_EPSILON
      && position.x < this.expandedBounds.max.x - COLLISION_EPSILON
      && position.z > this.expandedBounds.min.z + COLLISION_EPSILON
      && position.z < this.expandedBounds.max.z - COLLISION_EPSILON
  }

  resolve(currentPosition, desiredPosition, context = {}) {
    const eyeHeight = context.eyeHeight ?? 1.75
    if (!this.intersectsPlayer(desiredPosition, eyeHeight)) return desiredPosition

    this.resolvedPosition.copy(currentPosition)
    this.resolvedPosition.y = desiredPosition.y

    this.axisCandidate.set(desiredPosition.x, desiredPosition.y, currentPosition.z)
    if (!this.intersectsPlayer(this.axisCandidate, eyeHeight)) {
      this.resolvedPosition.x = desiredPosition.x
    }

    this.axisCandidate.set(this.resolvedPosition.x, desiredPosition.y, desiredPosition.z)
    if (!this.intersectsPlayer(this.axisCandidate, eyeHeight)) {
      this.resolvedPosition.z = desiredPosition.z
    }

    return this.resolvedPosition
  }

  getReport() {
    return {
      type: 'locomotive_aabb_capsule',
      playerRadius: this.playerRadius,
      min: this.sourceBounds.min.toArray(),
      max: this.sourceBounds.max.toArray(),
      expandedMin: this.expandedBounds.min.toArray(),
      expandedMax: this.expandedBounds.max.toArray(),
    }
  }
}

export function createLocomotiveCollisionResolver(bounds, options) {
  return new LocomotiveCollisionResolver(bounds, options)
}
