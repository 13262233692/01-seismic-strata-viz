import * as THREE from 'three';

export interface PlaneState {
  normal: THREE.Vector3;
  constant: number;
  origin: THREE.Vector3;
}

export class ClippingPlane {
  private _normal: THREE.Vector3;
  private _constant: number;
  private _origin: THREE.Vector3;
  private _tempVector: THREE.Vector3;

  constructor(normal?: THREE.Vector3, constant?: number) {
    this._normal = normal ? normal.clone().normalize() : new THREE.Vector3(0, 0, 1);
    this._constant = constant !== undefined ? constant : 0;
    this._origin = new THREE.Vector3();
    this._tempVector = new THREE.Vector3();
    this.updateOrigin();
  }

  get normal(): THREE.Vector3 {
    return this._normal;
  }

  get constant(): number {
    return this._constant;
  }

  get origin(): THREE.Vector3 {
    return this._origin;
  }

  setNormal(normal: THREE.Vector3): this {
    this._normal.copy(normal).normalize();
    this.updateOrigin();
    return this;
  }

  setConstant(constant: number): this {
    this._constant = constant;
    this.updateOrigin();
    return this;
  }

  setFromNormalAndCoplanarPoint(normal: THREE.Vector3, point: THREE.Vector3): this {
    this._normal.copy(normal).normalize();
    this._constant = -point.dot(this._normal);
    this._origin.copy(point);
    return this;
  }

  setFromThreePlane(plane: THREE.Plane): this {
    this._normal.copy(plane.normal);
    this._constant = plane.constant;
    this.updateOrigin();
    return this;
  }

  toThreePlane(target?: THREE.Plane): THREE.Plane {
    const plane = target || new THREE.Plane();
    plane.normal.copy(this._normal);
    plane.constant = this._constant;
    return plane;
  }

  distanceToPoint(point: THREE.Vector3): number {
    return this._normal.dot(point) + this._constant;
  }

  projectPoint(point: THREE.Vector3, target?: THREE.Vector3): THREE.Vector3 {
    const result = target || new THREE.Vector3();
    const d = this.distanceToPoint(point);
    result.copy(point).sub(this._tempVector.copy(this._normal).multiplyScalar(d));
    return result;
  }

  translate(offset: THREE.Vector3): this {
    const projectedOffset = this._tempVector.copy(offset);
    const normalComponent = projectedOffset.dot(this._normal);
    this._constant -= normalComponent;
    this._origin.add(offset);
    return this;
  }

  translateAlongNormal(distance: number): this {
    this._constant -= distance;
    this._origin.add(this._tempVector.copy(this._normal).multiplyScalar(distance));
    return this;
  }

  rotate(axis: THREE.Vector3, angle: number, center?: THREE.Vector3): this {
    const rotationCenter = center || this._origin;
    
    const quaternion = new THREE.Quaternion().setFromAxisAngle(axis, angle);
    
    this._normal.applyQuaternion(quaternion).normalize();
    
    this._origin.sub(rotationCenter);
    this._origin.applyQuaternion(quaternion);
    this._origin.add(rotationCenter);
    
    this._constant = -this._origin.dot(this._normal);
    
    return this;
  }

  rotateX(angle: number, center?: THREE.Vector3): this {
    return this.rotate(new THREE.Vector3(1, 0, 0), angle, center);
  }

  rotateY(angle: number, center?: THREE.Vector3): this {
    return this.rotate(new THREE.Vector3(0, 1, 0), angle, center);
  }

  rotateZ(angle: number, center?: THREE.Vector3): this {
    return this.rotate(new THREE.Vector3(0, 0, 1), angle, center);
  }

  intersectLine(start: THREE.Vector3, end: THREE.Vector3, target?: THREE.Vector3): THREE.Vector3 | null {
    const direction = this._tempVector.subVectors(end, start);
    const denominator = this._normal.dot(direction);
    
    if (Math.abs(denominator) < 1e-10) {
      return null;
    }
    
    const t = -(this._normal.dot(start) + this._constant) / denominator;
    
    if (t < 0 || t > 1) {
      return null;
    }
    
    const result = target || new THREE.Vector3();
    result.copy(start).add(direction.multiplyScalar(t));
    return result;
  }

  intersectBox(box: THREE.Box3): THREE.Vector3[] {
    const corners = this.getBoxCorners(box);
    const intersections: THREE.Vector3[] = [];
    
    const edges = [
      [0, 1], [1, 3], [3, 2], [2, 0],
      [4, 5], [5, 7], [7, 6], [6, 4],
      [0, 4], [1, 5], [2, 6], [3, 7]
    ];
    
    for (const [i, j] of edges) {
      const intersection = this.intersectLine(corners[i], corners[j]);
      if (intersection) {
        intersections.push(intersection);
      }
    }
    
    return this.removeDuplicatePoints(intersections);
  }

  private getBoxCorners(box: THREE.Box3): THREE.Vector3[] {
    const corners: THREE.Vector3[] = [];
    const min = box.min;
    const max = box.max;
    
    corners.push(new THREE.Vector3(min.x, min.y, min.z));
    corners.push(new THREE.Vector3(max.x, min.y, min.z));
    corners.push(new THREE.Vector3(min.x, max.y, min.z));
    corners.push(new THREE.Vector3(max.x, max.y, min.z));
    corners.push(new THREE.Vector3(min.x, min.y, max.z));
    corners.push(new THREE.Vector3(max.x, min.y, max.z));
    corners.push(new THREE.Vector3(min.x, max.y, max.z));
    corners.push(new THREE.Vector3(max.x, max.y, max.z));
    
    return corners;
  }

  private removeDuplicatePoints(points: THREE.Vector3[], epsilon: number = 1e-4): THREE.Vector3[] {
    const result: THREE.Vector3[] = [];
    
    for (const point of points) {
      let isDuplicate = false;
      for (const existing of result) {
        if (point.distanceTo(existing) < epsilon) {
          isDuplicate = true;
          break;
        }
      }
      if (!isDuplicate) {
        result.push(point);
      }
    }
    
    return result;
  }

  copy(other: ClippingPlane): this {
    this._normal.copy(other._normal);
    this._constant = other._constant;
    this._origin.copy(other._origin);
    return this;
  }

  clone(): ClippingPlane {
    return new ClippingPlane().copy(this);
  }

  equals(other: ClippingPlane, epsilon: number = 1e-6): boolean {
    return (
      this._normal.distanceTo(other._normal) < epsilon &&
      Math.abs(this._constant - other._constant) < epsilon
    );
  }

  getState(): PlaneState {
    return {
      normal: this._normal.clone(),
      constant: this._constant,
      origin: this._origin.clone(),
    };
  }

  fromState(state: PlaneState): this {
    this._normal.copy(state.normal);
    this._constant = state.constant;
    this._origin.copy(state.origin);
    return this;
  }

  private updateOrigin(): void {
    this._origin.copy(this._normal).multiplyScalar(-this._constant);
  }
}
