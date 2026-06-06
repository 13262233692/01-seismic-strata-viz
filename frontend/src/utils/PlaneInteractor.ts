import * as THREE from 'three';
import { ClippingPlane } from './ClippingPlane';
import { resourceManager } from './ResourceManager';

export type InteractorMode = 'translate' | 'rotate' | 'none';
export type Axis = 'x' | 'y' | 'z' | 'normal';

export interface PlaneInteractorOptions {
  scene: THREE.Scene;
  camera: THREE.Camera;
  domElement: HTMLElement;
  bounds: THREE.Box3;
  groupId?: string;
}

export class PlaneInteractor {
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private domElement: HTMLElement;
  private bounds: THREE.Box3;
  private groupId: string;

  private clippingPlane: ClippingPlane;
  private planeMesh: THREE.Mesh | null = null;
  private planeGeometry: THREE.PlaneGeometry | null = null;
  private planeMaterial: THREE.MeshBasicMaterial | null = null;

  private handles: Map<Axis, THREE.Mesh> = new Map();
  private rotationHandles: Map<Axis, THREE.Line> = new Map();

  private raycaster: THREE.Raycaster;
  private mouse: THREE.Vector2;

  private isDragging = false;
  private dragMode: InteractorMode = 'none';
  private dragAxis: Axis | null = null;
  private dragStartPoint: THREE.Vector3 = new THREE.Vector3();
  private dragStartPlaneOrigin: THREE.Vector3 = new THREE.Vector3();
  private dragStartPlaneNormal: THREE.Vector3 = new THREE.Vector3();

  private isVisible = true;
  private isEnabled = true;

  private onChangeCallbacks: Array<(plane: ClippingPlane) => void> = [];
  private onDragStartCallbacks: Array<() => void> = [];
  private onDragEndCallbacks: Array<() => void> = [];

  private tempVector: THREE.Vector3 = new THREE.Vector3();
  private tempVector2: THREE.Vector3 = new THREE.Vector3();
  private tempPlane: THREE.Plane = new THREE.Plane();

  private handleSize = 1.0;
  private handleHoverScale = 1.3;

  constructor(options: PlaneInteractorOptions) {
    this.scene = options.scene;
    this.camera = options.camera;
    this.domElement = options.domElement;
    this.bounds = options.bounds;
    this.groupId = options.groupId || `plane_interactor_${Date.now()}`;

    const center = new THREE.Vector3();
    this.bounds.getCenter(center);
    this.clippingPlane = new ClippingPlane(
      new THREE.Vector3(0, 0, 1),
      -center.z
    );

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    resourceManager.registerCleanupHook(`plane_interactor_${this.groupId}`, () => this.dispose());

    this.createPlaneVisualization();
    this.createHandles();
    this.setupEventListeners();
    this.updatePlaneVisualization();
  }

  get plane(): ClippingPlane {
    return this.clippingPlane;
  }

  get enabled(): boolean {
    return this.isEnabled;
  }

  set enabled(value: boolean) {
    this.isEnabled = value;
    this.setVisibility(value && this.isVisible);
  }

  get visible(): boolean {
    return this.isVisible;
  }

  set visible(value: boolean) {
    this.isVisible = value;
    this.setVisibility(value && this.isEnabled);
  }

  setBounds(bounds: THREE.Box3): void {
    this.bounds = bounds;
    this.updateHandleSize();
    this.updatePlaneVisualization();
  }

  setPlane(plane: ClippingPlane): void {
    this.clippingPlane.copy(plane);
    this.updatePlaneVisualization();
    this.notifyChange();
  }

  reset(): void {
    const center = new THREE.Vector3();
    this.bounds.getCenter(center);
    this.clippingPlane.setFromNormalAndCoplanarPoint(
      new THREE.Vector3(0, 0, 1),
      center
    );
    this.updatePlaneVisualization();
    this.notifyChange();
  }

  onChange(callback: (plane: ClippingPlane) => void): () => void {
    this.onChangeCallbacks.push(callback);
    return () => {
      const idx = this.onChangeCallbacks.indexOf(callback);
      if (idx > -1) this.onChangeCallbacks.splice(idx, 1);
    };
  }

  onDragStart(callback: () => void): () => void {
    this.onDragStartCallbacks.push(callback);
    return () => {
      const idx = this.onDragStartCallbacks.indexOf(callback);
      if (idx > -1) this.onDragStartCallbacks.splice(idx, 1);
    };
  }

  onDragEnd(callback: () => void): () => void {
    this.onDragEndCallbacks.push(callback);
    return () => {
      const idx = this.onDragEndCallbacks.indexOf(callback);
      if (idx > -1) this.onDragEndCallbacks.splice(idx, 1);
    };
  }

  private createPlaneVisualization(): void {
    const size = this.bounds.getSize(this.tempVector);
    const maxSize = Math.max(size.x, size.y, size.z) * 1.5;

    this.planeGeometry = new THREE.PlaneGeometry(maxSize, maxSize, 1, 1);
    this.planeMaterial = new THREE.MeshBasicMaterial({
      color: 0x00aaff,
      transparent: true,
      opacity: 0.15,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });

    this.planeMesh = new THREE.Mesh(this.planeGeometry, this.planeMaterial);
    this.planeMesh.name = 'clipping_plane_visual';
    this.scene.add(this.planeMesh);

    resourceManager.track(this.planeMesh, 'THREE.Mesh', 0, this.groupId, 'Clipping plane visual');
    resourceManager.track(this.planeGeometry, 'THREE.PlaneGeometry', 0, this.groupId, 'Clipping plane geometry');
    resourceManager.track(this.planeMaterial, 'THREE.MeshBasicMaterial', 0, this.groupId, 'Clipping plane material');

    const edgesGeometry = new THREE.EdgesGeometry(this.planeGeometry);
    const edgesMaterial = new THREE.LineBasicMaterial({ 
      color: 0x00aaff, 
      transparent: true, 
      opacity: 0.6 
    });
    const edges = new THREE.LineSegments(edgesGeometry, edgesMaterial);
    this.planeMesh.add(edges);
  }

  private createHandles(): void {
    this.createTranslateHandles();
    this.createRotationHandles();
    this.updateHandleSize();
  }

  private createTranslateHandles(): void {
    const axes: Array<{ axis: Axis; dir: THREE.Vector3; color: number }> = [
      { axis: 'x', dir: new THREE.Vector3(1, 0, 0), color: 0xff4444 },
      { axis: 'y', dir: new THREE.Vector3(0, 1, 0), color: 0x44ff44 },
      { axis: 'z', dir: new THREE.Vector3(0, 0, 1), color: 0x4444ff },
    ];

    for (const { axis, color } of axes) {
      const handleGeometry = new THREE.ConeGeometry(0.3, 0.8, 8);
      const handleMaterial = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.8,
        depthTest: false,
      });

      const handle = new THREE.Mesh(handleGeometry, handleMaterial);
      handle.name = `translate_handle_${axis}`;
      handle.userData.axis = axis;
      handle.userData.type = 'translate';

      this.scene.add(handle);
      this.handles.set(axis, handle);

      resourceManager.track(handle, `Handle_${axis}`, 0, this.groupId, `Translate handle ${axis}`);
    }

    const normalGeometry = new THREE.ConeGeometry(0.5, 1.2, 8);
    const normalMaterial = new THREE.MeshBasicMaterial({
      color: 0xffff00,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
    });

    const normalHandle = new THREE.Mesh(normalGeometry, normalMaterial);
    normalHandle.name = 'translate_handle_normal';
    normalHandle.userData.axis = 'normal';
    normalHandle.userData.type = 'translate';

    this.scene.add(normalHandle);
    this.handles.set('normal', normalHandle);
    resourceManager.track(normalHandle, 'Handle_normal', 0, this.groupId, 'Translate handle normal');
  }

  private createRotationHandles(): void {
    const axes: Array<{ axis: Axis; color: number }> = [
      { axis: 'x', color: 0xff4444 },
      { axis: 'y', color: 0x44ff44 },
      { axis: 'z', color: 0x4444ff },
    ];

    for (const { axis, color } of axes) {
      const curve = new THREE.EllipseCurve(
        0, 0,
        this.handleSize * 2.5, this.handleSize * 2.5,
        0, Math.PI / 2,
        false,
        0
      );

      const points = curve.getPoints(32);
      const geometry = new THREE.BufferGeometry().setFromPoints(
        points.map(p => {
          const v = new THREE.Vector3(p.x, p.y, 0);
          if (axis === 'x') v.set(0, p.x, p.y);
          if (axis === 'y') v.set(p.x, 0, p.y);
          return v;
        })
      );

      const material = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.6,
        depthTest: false,
      });

      const handle = new THREE.Line(geometry, material);
      handle.name = `rotate_handle_${axis}`;
      handle.userData.axis = axis;
      handle.userData.type = 'rotate';

      this.scene.add(handle);
      this.rotationHandles.set(axis, handle);

      resourceManager.track(handle, `RotateHandle_${axis}`, 0, this.groupId, `Rotation handle ${axis}`);
    }
  }

  private updateHandleSize(): void {
    const size = this.bounds.getSize(this.tempVector);
    this.handleSize = Math.max(size.x, size.y, size.z) * 0.08;
  }

  private updatePlaneVisualization(): void {
    if (!this.planeMesh) return;

    const origin = this.clippingPlane.origin;
    const normal = this.clippingPlane.normal;

    this.planeMesh.position.copy(origin);

    const quaternion = new THREE.Quaternion();
    quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    this.planeMesh.quaternion.copy(quaternion);

    this.updateHandlePositions();
  }

  private updateHandlePositions(): void {
    const origin = this.clippingPlane.origin;
    const normal = this.clippingPlane.normal;

    const normalHandle = this.handles.get('normal');
    if (normalHandle) {
      normalHandle.position.copy(origin).add(
        this.tempVector.copy(normal).multiplyScalar(this.handleSize * 2)
      );
      normalHandle.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        normal
      );
      normalHandle.scale.setScalar(this.handleSize);
    }

    const axes: Array<{ axis: Axis; dir: THREE.Vector3 }> = [
      { axis: 'x', dir: new THREE.Vector3(1, 0, 0) },
      { axis: 'y', dir: new THREE.Vector3(0, 1, 0) },
      { axis: 'z', dir: new THREE.Vector3(0, 0, 1) },
    ];

    for (const { axis, dir } of axes) {
      const handle = this.handles.get(axis);
      if (handle) {
        handle.position.copy(origin).add(
          this.tempVector.copy(dir).multiplyScalar(this.handleSize * 2.5)
        );
        handle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        handle.scale.setScalar(this.handleSize);
      }

      const rotHandle = this.rotationHandles.get(axis);
      if (rotHandle) {
        rotHandle.position.copy(origin);
        rotHandle.scale.setScalar(this.handleSize);
      }
    }
  }

  private setVisibility(visible: boolean): void {
    if (this.planeMesh) {
      this.planeMesh.visible = visible;
    }

    for (const handle of this.handles.values()) {
      handle.visible = visible;
    }

    for (const handle of this.rotationHandles.values()) {
      handle.visible = visible;
    }
  }

  private setupEventListeners(): void {
    this.domElement.addEventListener('mousedown', this.onMouseDown);
    this.domElement.addEventListener('mousemove', this.onMouseMove);
    this.domElement.addEventListener('mouseup', this.onMouseUp);
    this.domElement.addEventListener('wheel', this.onWheel, { passive: false });
  }

  private onMouseDown = (event: MouseEvent): void => {
    if (!this.isEnabled || !this.isVisible) return;
    if (event.button !== 0) return;

    this.updateMouse(event);
    this.raycaster.setFromCamera(this.mouse, this.camera);

    const allHandles = [...this.handles.values(), ...this.rotationHandles.values()];
    const intersects = this.raycaster.intersectObjects(allHandles, false);

    if (intersects.length > 0) {
      event.preventDefault();
      event.stopPropagation();

      const handle = intersects[0].object;
      this.dragMode = handle.userData.type as InteractorMode;
      this.dragAxis = handle.userData.axis as Axis;
      this.isDragging = true;

      this.dragStartPoint.copy(intersects[0].point);
      this.dragStartPlaneOrigin.copy(this.clippingPlane.origin);
      this.dragStartPlaneNormal.copy(this.clippingPlane.normal);

      this.notifyDragStart();
    }
  };

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.isEnabled || !this.isVisible) return;

    this.updateMouse(event);

    if (this.isDragging && this.dragAxis) {
      event.preventDefault();
      event.stopPropagation();
      this.handleDrag();
    } else {
      this.raycaster.setFromCamera(this.mouse, this.camera);
      this.updateHandleHover();
    }
  };

  private onMouseUp = (): void => {
    if (this.isDragging) {
      this.isDragging = false;
      this.dragMode = 'none';
      this.dragAxis = null;
      this.notifyDragEnd();
    }
  };

  private onWheel = (event: WheelEvent): void => {
    if (!this.isEnabled || !this.isVisible) return;
    if (!event.ctrlKey && !event.shiftKey) return;

    event.preventDefault();
    event.stopPropagation();

    const delta = event.deltaY > 0 ? 1 : -1;
    const step = this.bounds.getSize(this.tempVector).length() * 0.01;

    this.clippingPlane.translateAlongNormal(delta * step);
    this.updatePlaneVisualization();
    this.notifyChange();
  };

  private updateMouse(event: MouseEvent): void {
    const rect = this.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private handleDrag(): void {
    if (!this.dragAxis) return;

    this.raycaster.setFromCamera(this.mouse, this.camera);

    if (this.dragMode === 'translate') {
      this.handleTranslateDrag();
    } else if (this.dragMode === 'rotate') {
      this.handleRotateDrag();
    }
  }

  private handleTranslateDrag(): void {
    if (!this.dragAxis) return;

    let dragDirection: THREE.Vector3;

    if (this.dragAxis === 'normal') {
      dragDirection = this.dragStartPlaneNormal.clone();
    } else {
      const axisMap: Record<Axis, THREE.Vector3> = {
        x: new THREE.Vector3(1, 0, 0),
        y: new THREE.Vector3(0, 1, 0),
        z: new THREE.Vector3(0, 0, 1),
        normal: this.dragStartPlaneNormal.clone(),
      };
      dragDirection = axisMap[this.dragAxis];
    }

    this.tempPlane.setFromNormalAndCoplanarPoint(
      this.camera.getWorldDirection(this.tempVector2).negate(),
      this.dragStartPoint
    );

    const currentPoint = new THREE.Vector3();
    this.raycaster.ray.intersectPlane(this.tempPlane, currentPoint);

    if (currentPoint) {
      const delta = currentPoint.sub(this.dragStartPoint);
      const projectedDelta = delta.dot(dragDirection);
      
      const newOrigin = this.dragStartPlaneOrigin.clone().add(
        dragDirection.clone().multiplyScalar(projectedDelta)
      );

      this.clippingPlane.setFromNormalAndCoplanarPoint(
        this.dragStartPlaneNormal,
        newOrigin
      );

      this.updatePlaneVisualization();
      this.notifyChange();
    }
  }

  private handleRotateDrag(): void {
    if (!this.dragAxis) return;

    const axisMap: Record<Axis, THREE.Vector3> = {
      x: new THREE.Vector3(1, 0, 0),
      y: new THREE.Vector3(0, 1, 0),
      z: new THREE.Vector3(0, 0, 1),
      normal: this.dragStartPlaneNormal.clone(),
    };

    const rotationAxis = axisMap[this.dragAxis];

    this.tempPlane.setFromNormalAndCoplanarPoint(
      this.camera.getWorldDirection(this.tempVector2).negate(),
      this.dragStartPlaneOrigin
    );

    const currentPoint = new THREE.Vector3();
    this.raycaster.ray.intersectPlane(this.tempPlane, currentPoint);

    if (currentPoint) {
      const startDir = this.dragStartPoint.clone().sub(this.dragStartPlaneOrigin).normalize();
      const endDir = currentPoint.clone().sub(this.dragStartPlaneOrigin).normalize();

      let angle = Math.atan2(
        startDir.cross(endDir).dot(rotationAxis),
        startDir.dot(endDir)
      );

      const newPlane = this.clippingPlane.clone();
      newPlane.fromState({
        normal: this.dragStartPlaneNormal.clone(),
        constant: -this.dragStartPlaneOrigin.dot(this.dragStartPlaneNormal),
        origin: this.dragStartPlaneOrigin.clone(),
      });
      newPlane.rotate(rotationAxis, angle, this.dragStartPlaneOrigin);

      this.clippingPlane.copy(newPlane);
      this.updatePlaneVisualization();
      this.notifyChange();
    }
  }

  private updateHandleHover(): void {
    const allHandles = [...this.handles.values(), ...this.rotationHandles.values()];
    const intersects = this.raycaster.intersectObjects(allHandles, false);

    for (const handle of allHandles) {
      const scale = this.handleSize * (handle === intersects[0]?.object ? this.handleHoverScale : 1);
      handle.scale.setScalar(scale);
    }
  }

  private notifyChange(): void {
    for (const cb of this.onChangeCallbacks) {
      cb(this.clippingPlane);
    }
  }

  private notifyDragStart(): void {
    for (const cb of this.onDragStartCallbacks) {
      cb();
    }
  }

  private notifyDragEnd(): void {
    for (const cb of this.onDragEndCallbacks) {
      cb();
    }
  }

  async dispose(): Promise<void> {
    this.domElement.removeEventListener('mousedown', this.onMouseDown);
    this.domElement.removeEventListener('mousemove', this.onMouseMove);
    this.domElement.removeEventListener('mouseup', this.onMouseUp);
    this.domElement.removeEventListener('wheel', this.onWheel);

    if (this.planeMesh) {
      this.scene.remove(this.planeMesh);
      if (this.planeGeometry) this.planeGeometry.dispose();
      if (this.planeMaterial) this.planeMaterial.dispose();
    }

    for (const handle of this.handles.values()) {
      this.scene.remove(handle);
      (handle.geometry as THREE.BufferGeometry).dispose();
      (handle.material as THREE.Material).dispose();
    }
    this.handles.clear();

    for (const handle of this.rotationHandles.values()) {
      this.scene.remove(handle);
      (handle.geometry as THREE.BufferGeometry).dispose();
      (handle.material as THREE.Material).dispose();
    }
    this.rotationHandles.clear();

    resourceManager.unregisterCleanupHook(`plane_interactor_${this.groupId}`);
    await resourceManager.disposeGroup(this.groupId, true);

    this.onChangeCallbacks = [];
    this.onDragStartCallbacks = [];
    this.onDragEndCallbacks = [];
  }
}
