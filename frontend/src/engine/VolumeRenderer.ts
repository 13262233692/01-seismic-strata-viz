import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DataBlock, VolumeRenderSettings, SEGYHeader } from '../types';
import { ColormapManager } from './ColormapManager';
import { OctreeScheduler } from './OctreeScheduler';
import { resourceManager } from '../utils/ResourceManager';
import { ClippingPlane } from '../utils/ClippingPlane';
import { PlaneInteractor } from '../utils/PlaneInteractor';

const vertexShader = `
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

varying vec3 vWorldPosition;
varying vec3 vLocalPosition;
varying vec2 vUv;

void main() {
  vUv = uv;
  vLocalPosition = position;
  
  vec4 worldPosition = modelViewMatrix * vec4(position, 1.0);
  vWorldPosition = worldPosition.xyz;
  
  gl_Position = projectionMatrix * worldPosition;
}
`;

const fragmentShader = `
precision highp float;
precision highp sampler3D;
precision highp sampler2D;

uniform sampler3D uVolumeData;
uniform sampler2D uColormap;
uniform vec3 uVolumeSize;
uniform vec3 uVolumeDimensions;
uniform float uSampleRate;
uniform float uOpacity;
uniform float uBrightness;
uniform float uContrast;
uniform float uThreshold;
uniform vec3 uCameraPos;
uniform vec3 uBoundsMin;
uniform vec3 uBoundsMax;
uniform float uMinValue;
uniform float uMaxValue;

uniform bool uEnableClipping;
uniform vec3 uClipPlaneNormal;
uniform float uClipPlaneConstant;

varying vec3 vWorldPosition;
varying vec3 vLocalPosition;
varying vec2 vUv;

float distanceToPlane(vec3 point, vec3 normal, float constant) {
  return dot(normal, point) + constant;
}

bool isBehindClipPlane(vec3 point) {
  if (!uEnableClipping) return false;
  return distanceToPlane(point, uClipPlaneNormal, uClipPlaneConstant) > 0.001;
}

bool intersectBox(vec3 ro, vec3 rd, vec3 boxMin, vec3 boxMax, out float tNear, out float tFar) {
  vec3 invR = 1.0 / rd;
  vec3 tbot = invR * (boxMin - ro);
  vec3 ttop = invR * (boxMax - ro);
  vec3 tmin = min(ttop, tbot);
  vec3 tmax = max(ttop, tbot);
  vec2 t = max(tmin.xx, tmin.yz);
  tNear = max(t.x, t.y);
  t = min(tmax.xx, tmax.yz);
  tFar = min(t.x, t.y);
  return tNear < tFar && tFar > 0.0;
}

bool intersectRayPlane(vec3 ro, vec3 rd, vec3 planeNormal, float planeConstant, out float t) {
  float denom = dot(planeNormal, rd);
  if (abs(denom) < 1e-6) return false;
  t = -(dot(planeNormal, ro) + planeConstant) / denom;
  return t >= 0.0;
}

vec3 localToUvw(vec3 localPos, vec3 boundsMin, vec3 boundsMax) {
  return (localPos - boundsMin) / (boundsMax - boundsMin);
}

float sampleVolume(vec3 uvw) {
  if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) {
    return 0.0;
  }
  return texture(uVolumeData, uvw).r;
}

vec4 applyColormap(float value, float minVal, float maxVal) {
  float normalized = (value - minVal) / (maxVal - minVal);
  normalized = clamp(normalized, 0.0, 1.0);
  return texture2D(uColormap, vec2(normalized, 0.5));
}

float applyBrightnessContrast(float value, float brightness, float contrast) {
  value = (value - 0.5) * contrast + 0.5;
  value = value + brightness;
  return clamp(value, 0.0, 1.0);
}

void main() {
  vec3 ro = uCameraPos;
  vec3 rd = normalize(vWorldPosition - ro);
  
  float tNear, tFar;
  if (!intersectBox(ro, rd, uBoundsMin, uBoundsMax, tNear, tFar)) {
    discard;
  }
  
  tNear = max(tNear, 0.0);
  
  vec3 startPos = ro + rd * tNear;
  vec3 endPos = ro + rd * tFar;
  
  if (uEnableClipping) {
    float tPlane;
    if (intersectRayPlane(ro, rd, uClipPlaneNormal, uClipPlaneConstant, tPlane)) {
      if (tPlane > tNear && tPlane < tFar) {
        if (isBehindClipPlane(startPos)) {
          startPos = ro + rd * tPlane;
        } else {
          endPos = ro + rd * tPlane;
        }
      }
    }
    
    if (isBehindClipPlane(startPos) && isBehindClipPlane(endPos)) {
      discard;
    }
  }
  
  float stepSize = uSampleRate * 0.5;
  vec3 step = rd * stepSize;
  
  float maxDist = length(endPos - startPos);
  int maxSteps = int(maxDist / stepSize);
  maxSteps = min(maxSteps, 512);
  
  vec4 accumulatedColor = vec4(0.0);
  
  vec3 currentPos = startPos;
  
  for (int i = 0; i < 512; i++) {
    if (i >= maxSteps) break;
    if (accumulatedColor.a >= 0.95) break;
    
    if (isBehindClipPlane(currentPos)) {
      currentPos += step;
      continue;
    }
    
    vec3 uvw = localToUvw(currentPos, uBoundsMin, uBoundsMax);
    float density = sampleVolume(uvw);
    
    if (density > uThreshold) {
      float normalizedDensity = (density - uMinValue) / (uMaxValue - uMinValue);
      normalizedDensity = applyBrightnessContrast(normalizedDensity, uBrightness, uContrast);
      
      vec4 sampleColor = applyColormap(density, uMinValue, uMaxValue);
      sampleColor.a = normalizedDensity * uOpacity * stepSize * 2.0;
      
      sampleColor.rgb *= sampleColor.a;
      accumulatedColor += sampleColor * (1.0 - accumulatedColor.a);
    }
    
    currentPos += step;
  }
  
  if (accumulatedColor.a < 0.01) {
    discard;
  }
  
  gl_FragColor = vec4(accumulatedColor.rgb, accumulatedColor.a);
}
`;

export interface VolumeRendererOptions {
  container: HTMLElement;
  settings?: Partial<VolumeRenderSettings>;
}

interface TrackedGLResource {
  id: string;
  type: 'texture' | 'geometry' | 'material' | 'renderer' | 'buffer';
  object: any;
}

export class VolumeRenderer {
  private container: HTMLElement;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private controls!: OrbitControls;
  private animationFrameId: number | null = null;
  
  private volumeMesh: THREE.Mesh | null = null;
  private volumeMaterial: THREE.ShaderMaterial | null = null;
  private volumeTexture: THREE.Data3DTexture | null = null;
  private colormapTexture: THREE.DataTexture | null = null;
  
  private trackedResources: Map<string, TrackedGLResource> = new Map();
  private colormapManager: ColormapManager;
  private octreeScheduler: OctreeScheduler;
  
  private settings: VolumeRenderSettings;
  private header: SEGYHeader | null = null;
  private volumeData: Float32Array | null = null;
  private volumeDataResourceId: string | null = null;
  private volumeDimensions: { width: number; height: number; depth: number } = { width: 0, height: 0, depth: 0 };
  private valueRange: { min: number; max: number } = { min: 0, max: 1 };
  
  private blocks: Map<string, DataBlock> = new Map();
  private groupId: string;
  private isDisposed = false;
  private isClearing = false;
  
  private lights: THREE.Light[] = [];
  
  private clippingEnabled = false;
  private planeInteractor: PlaneInteractor | null = null;
  private fpsCounter = { frames: 0, lastTime: performance.now(), currentFps: 60 };
  
  constructor(options: VolumeRendererOptions) {
    this.container = options.container;
    this.colormapManager = new ColormapManager();
    this.groupId = `renderer_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.octreeScheduler = new OctreeScheduler(this.groupId);
    
    this.settings = {
      colormap: options.settings?.colormap || this.colormapManager.getDefaultColormap(),
      sampleRate: options.settings?.sampleRate || 1.0,
      opacity: options.settings?.opacity || 0.5,
      brightness: options.settings?.brightness || 0.0,
      contrast: options.settings?.contrast || 1.0,
      threshold: options.settings?.threshold || 0.0,
    };
    
    resourceManager.registerCleanupHook(`renderer_${this.groupId}`, () => this.dispose());
    this.init();
  }
  
  private init(): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0a0f);
    
    resourceManager.track(this.scene, 'THREE.Scene', 0, this.groupId, 'Main scene');
    
    const { clientWidth, clientHeight } = this.container;
    
    this.camera = new THREE.PerspectiveCamera(
      60,
      clientWidth / clientHeight,
      0.1,
      10000
    );
    this.camera.position.set(100, 100, 100);
    resourceManager.track(this.camera, 'THREE.Camera', 0, this.groupId, 'Main camera');
    
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer.setSize(clientWidth, clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.sortObjects = false;
    this.trackResource(this.renderer, 'renderer', 'Main WebGLRenderer');
    
    this.container.appendChild(this.renderer.domElement);
    
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxPolarAngle = Math.PI / 2.1;
    resourceManager.track(this.controls, 'OrbitControls', 0, this.groupId, 'Camera controls');
    
    this.setupLights();
    this.setupColormapTexture();
    this.setupEventListeners();
    this.animate();
  }
  
  private setupLights(): void {
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(ambientLight);
    this.lights.push(ambientLight);
    resourceManager.track(ambientLight, 'THREE.AmbientLight', 0, this.groupId, 'Ambient light');
    
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(1, 1, 1);
    this.scene.add(directionalLight);
    this.lights.push(directionalLight);
    resourceManager.track(directionalLight, 'THREE.DirectionalLight', 0, this.groupId, 'Directional light');
  }
  
  private setupColormapTexture(): void {
    const colormapData = this.colormapManager.createColormapTexture(this.settings.colormap);
    
    if (this.colormapTexture) {
      this.disposeTexture(this.colormapTexture);
    }
    
    this.colormapTexture = new THREE.DataTexture(
      colormapData as any,
      256,
      1,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    );
    this.colormapTexture.needsUpdate = true;
    this.trackResource(this.colormapTexture, 'texture', 'Colormap texture');
  }
  
  private setupEventListeners(): void {
    window.addEventListener('resize', this.handleResize);
  }
  
  private handleResize = (): void => {
    if (this.isDisposed) return;
    
    const { clientWidth, clientHeight } = this.container;
    
    this.camera.aspect = clientWidth / clientHeight;
    this.camera.updateProjectionMatrix();
    
    this.renderer.setSize(clientWidth, clientHeight);
  };
  
  private animate = (): void => {
    if (this.isDisposed) return;
    
    this.animationFrameId = requestAnimationFrame(this.animate);
    
    this.fpsCounter.frames++;
    const now = performance.now();
    if (now - this.fpsCounter.lastTime >= 1000) {
      this.fpsCounter.currentFps = this.fpsCounter.frames;
      this.fpsCounter.frames = 0;
      this.fpsCounter.lastTime = now;
    }
    
    this.controls.update();
    this.updateUniforms();
    this.render();
  };
  
  private render(): void {
    if (this.isDisposed || this.isClearing) return;
    
    try {
      this.renderer.render(this.scene, this.camera);
    } catch (error) {
      console.error('[VolumeRenderer] Render error:', error);
    }
  }
  
  private updateUniforms(): void {
    if (!this.volumeMaterial || this.isDisposed) return;
    
    try {
      const uniforms = this.volumeMaterial.uniforms;
      
      uniforms.uCameraPos.value.copy(this.camera.position);
      uniforms.uSampleRate.value = this.settings.sampleRate;
      uniforms.uOpacity.value = this.settings.opacity;
      uniforms.uBrightness.value = this.settings.brightness;
      uniforms.uContrast.value = this.settings.contrast;
      uniforms.uThreshold.value = this.settings.threshold;
    } catch (error) {
      console.error('[VolumeRenderer] Uniform update error:', error);
    }
  }
  
  private trackResource(object: any, type: TrackedGLResource['type'], description?: string): string {
    const id = `gl_${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    let size = 0;
    if (type === 'texture' && object.image?.data) {
      size = object.image.data.byteLength || 0;
    }
    
    this.trackedResources.set(id, { id, type, object });
    resourceManager.track(object, `THREE.${type.charAt(0).toUpperCase() + type.slice(1)}`, size, this.groupId, description);
    
    return id;
  }
  
  private disposeTexture(texture: THREE.Texture): void {
    try {
      if (texture.image?.data) {
        if (texture.image.data.buffer && typeof texture.image.data.buffer.transfer === 'function') {
          texture.image.data.buffer.transfer();
        }
      }
      texture.dispose();
    } catch (error) {
      console.warn('[VolumeRenderer] Texture dispose warning:', error);
    }
    
    for (const [id, res] of this.trackedResources) {
      if (res.object === texture) {
        this.trackedResources.delete(id);
        resourceManager.untrack(id);
        break;
      }
    }
  }
  
  private disposeGeometry(geometry: THREE.BufferGeometry): void {
    try {
      for (const key of Object.keys(geometry.attributes)) {
        const attr = geometry.attributes[key];
        const buffer = attr.array?.buffer as any;
        if (buffer && typeof buffer.transfer === 'function') {
          buffer.transfer();
        }
      }
      geometry.dispose();
    } catch (error) {
      console.warn('[VolumeRenderer] Geometry dispose warning:', error);
    }
    
    for (const [id, res] of this.trackedResources) {
      if (res.object === geometry) {
        this.trackedResources.delete(id);
        resourceManager.untrack(id);
        break;
      }
    }
  }
  
  private disposeMaterial(material: THREE.Material): void {
    try {
      material.dispose();
    } catch (error) {
      console.warn('[VolumeRenderer] Material dispose warning:', error);
    }
    
    for (const [id, res] of this.trackedResources) {
      if (res.object === material) {
        this.trackedResources.delete(id);
        resourceManager.untrack(id);
        break;
      }
    }
  }
  
  async clearVolumeData(): Promise<void> {
    if (this.isClearing) return;
    this.isClearing = true;
    
    try {
      if (this.volumeMesh) {
        this.scene.remove(this.volumeMesh);
        
        if (this.volumeMesh.geometry) {
          this.disposeGeometry(this.volumeMesh.geometry);
        }
        
        if (this.volumeMaterial) {
          this.disposeMaterial(this.volumeMaterial);
          this.volumeMaterial = null;
        }
        
        this.volumeMesh = null;
      }
      
      if (this.volumeTexture) {
        this.disposeTexture(this.volumeTexture);
        this.volumeTexture = null;
      }
      
      if (this.volumeData) {
        if (this.volumeDataResourceId) {
          await resourceManager.dispose(this.volumeDataResourceId, true);
          this.volumeDataResourceId = null;
        }
        const buffer = this.volumeData.buffer as any;
        if (typeof buffer?.transfer === 'function') {
          buffer.transfer();
        }
        this.volumeData = null;
      }
      
      this.blocks.clear();
      this.volumeDimensions = { width: 0, height: 0, depth: 0 };
      this.valueRange = { min: 0, max: 1 };
      
      await this.octreeScheduler.dispose();
      
      await resourceManager.forceGC();
      
      if (this.renderer) {
        this.renderer.resetState();
      }
      
      await new Promise(resolve => setTimeout(resolve, 50));
      
    } finally {
      this.isClearing = false;
    }
  }
  
  setHeader(header: SEGYHeader): void {
    if (this.isDisposed) return;
    
    this.header = header;
    
    const xRange = header.max_x - header.min_x;
    const yRange = header.max_y - header.min_y;
    const zRange = header.max_z - header.min_z;
    
    const maxRange = Math.max(xRange, yRange, zRange);
    const scale = 200 / maxRange;
    
    this.camera.position.set(
      (header.max_x + header.min_x) / 2 * scale + maxRange * scale * 1.5,
      (header.max_y + header.min_y) / 2 * scale + maxRange * scale * 0.8,
      (header.max_z + header.min_z) / 2 * scale + maxRange * scale * 1.5
    );
    
    this.controls.target.set(
      (header.max_x + header.min_x) / 2 * scale,
      (header.max_y + header.min_y) / 2 * scale,
      (header.max_z + header.min_z) / 2 * scale
    );
    
    this.controls.update();
  }
  
  addBlock(block: DataBlock): void {
    if (this.isDisposed || this.isClearing) return;
    
    this.blocks.set(block.block_id, block);
    this.updateValueRange(block);
  }
  
  private updateValueRange(block: DataBlock): void {
    if (block.min_amplitude < this.valueRange.min) {
      this.valueRange.min = block.min_amplitude;
    }
    if (block.max_amplitude > this.valueRange.max) {
      this.valueRange.max = block.max_amplitude;
    }
  }
  
  setVolumeData(
    data: Float32Array,
    width: number,
    height: number,
    depth: number,
    header: SEGYHeader
  ): void {
    if (this.isDisposed) return;
    
    this.clearVolumeData().then(() => {
      if (this.isDisposed) return;
      
      this.volumeData = data;
      this.volumeDimensions = { width, height, depth };
      this.header = header;
      
      this.volumeDataResourceId = resourceManager.track(
        data,
        'Float32Array',
        data.byteLength,
        this.groupId,
        `Main volume data: ${width}x${height}x${depth}`
      );
      
      let min = Infinity;
      let max = -Infinity;
      const sampleStep = Math.max(1, Math.floor(data.length / 10000));
      for (let i = 0; i < data.length; i += sampleStep) {
        if (data[i] < min) min = data[i];
        if (data[i] > max) max = data[i];
      }
      this.valueRange = { min, max };
      
      this.createVolumeTexture();
      this.createVolumeMesh();
      this.updateCameraPosition();
    });
  }
  
  private createVolumeTexture(): void {
    if (!this.volumeData || this.isDisposed) return;
    
    const { width, height, depth } = this.volumeDimensions;
    
    if (this.volumeTexture) {
      this.disposeTexture(this.volumeTexture);
    }
    
    this.volumeTexture = new THREE.Data3DTexture(
      this.volumeData as any,
      width,
      height,
      depth
    );
    this.volumeTexture.type = THREE.FloatType;
    this.volumeTexture.format = THREE.RedFormat;
    this.volumeTexture.internalFormat = 'R32F';
    this.volumeTexture.minFilter = THREE.LinearFilter;
    this.volumeTexture.magFilter = THREE.LinearFilter;
    this.volumeTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.volumeTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.volumeTexture.wrapR = THREE.ClampToEdgeWrapping;
    this.volumeTexture.needsUpdate = true;
    
    this.trackResource(this.volumeTexture, 'texture', `Volume 3D texture: ${width}x${height}x${depth}`);
  }
  
  private createVolumeMesh(): void {
    if (this.isDisposed) return;
    
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    this.trackResource(geometry, 'geometry', 'Volume box geometry');
    
    const uniforms = {
      uVolumeData: { value: this.volumeTexture },
      uColormap: { value: this.colormapTexture },
      uVolumeSize: { value: new THREE.Vector3(1, 1, 1) },
      uVolumeDimensions: { value: new THREE.Vector3(
        this.volumeDimensions.width,
        this.volumeDimensions.height,
        this.volumeDimensions.depth
      )},
      uSampleRate: { value: this.settings.sampleRate },
      uOpacity: { value: this.settings.opacity },
      uBrightness: { value: this.settings.brightness },
      uContrast: { value: this.settings.contrast },
      uThreshold: { value: this.settings.threshold },
      uCameraPos: { value: new THREE.Vector3() },
      uBoundsMin: { value: new THREE.Vector3(-0.5, -0.5, -0.5) },
      uBoundsMax: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
      uMinValue: { value: this.valueRange.min },
      uMaxValue: { value: this.valueRange.max },
      uEnableClipping: { value: false },
      uClipPlaneNormal: { value: new THREE.Vector3(0, 0, 1) },
      uClipPlaneConstant: { value: 0.0 },
    };
    
    this.volumeMaterial = new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.trackResource(this.volumeMaterial, 'material', 'Volume shader material');
    
    this.volumeMesh = new THREE.Mesh(geometry, this.volumeMaterial);
    
    if (this.header) {
      const xRange = this.header.max_x - this.header.min_x;
      const yRange = this.header.max_y - this.header.min_y;
      const zRange = this.header.max_z - this.header.min_z;
      const maxRange = Math.max(xRange, yRange, zRange);
      const scale = 200 / maxRange;
      
      this.volumeMesh.scale.set(
        xRange * scale,
        yRange * scale,
        zRange * scale
      );
      
      this.volumeMesh.position.set(
        (this.header.max_x + this.header.min_x) / 2 * scale,
        (this.header.max_y + this.header.min_y) / 2 * scale,
        (this.header.max_z + this.header.min_z) / 2 * scale
      );
    }
    
    this.scene.add(this.volumeMesh);
    
    this.initPlaneInteractor();
  }
  
  private initPlaneInteractor(): void {
    if (!this.volumeMesh || this.isDisposed) return;
    
    if (this.planeInteractor) {
      this.planeInteractor.dispose();
      this.planeInteractor = null;
    }
    
    const box = new THREE.Box3().setFromObject(this.volumeMesh);
    
    this.planeInteractor = new PlaneInteractor({
      scene: this.scene,
      camera: this.camera,
      domElement: this.renderer.domElement,
      bounds: box,
      groupId: this.groupId,
    });
    
    this.planeInteractor.visible = false;
    this.planeInteractor.enabled = false;
    
    this.planeInteractor.onChange((plane) => {
      this.updateClipPlaneUniforms(plane);
    });
  }
  
  private updateClipPlaneUniforms(plane: ClippingPlane): void {
    if (!this.volumeMaterial || this.isDisposed) return;
    
    const uniforms = this.volumeMaterial.uniforms;
    
    if (this.volumeMesh) {
      const inverseMatrix = new THREE.Matrix4().copy(this.volumeMesh.matrixWorld).invert();
      const localNormal = plane.normal.clone().applyMatrix4(inverseMatrix).normalize();
      
      const worldOrigin = plane.origin.clone();
      const localOrigin = worldOrigin.clone().applyMatrix4(inverseMatrix);
      const localConstant = -localOrigin.dot(localNormal);
      
      uniforms.uClipPlaneNormal.value.copy(localNormal);
      uniforms.uClipPlaneConstant.value = localConstant;
    } else {
      uniforms.uClipPlaneNormal.value.copy(plane.normal);
      uniforms.uClipPlaneConstant.value = plane.constant;
    }
    
    uniforms.uEnableClipping.value = this.clippingEnabled;
  }
  
  private updateCameraPosition(): void {
    if (!this.header || !this.volumeMesh || this.isDisposed) return;
    
    const box = new THREE.Box3().setFromObject(this.volumeMesh);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = this.camera.fov * (Math.PI / 180);
    let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
    cameraZ *= 1.5;
    
    this.camera.position.set(center.x + cameraZ, center.y + cameraZ * 0.5, center.z + cameraZ);
    this.controls.target.copy(center);
    this.controls.update();
  }
  
  updateSettings(settings: Partial<VolumeRenderSettings>): void {
    if (this.isDisposed) return;
    
    this.settings = { ...this.settings, ...settings };
    
    if (settings.colormap) {
      const colormapData = this.colormapManager.createColormapTexture(settings.colormap);
      
      if (this.colormapTexture) {
        this.disposeTexture(this.colormapTexture);
      }
      
      this.colormapTexture = new THREE.DataTexture(
        colormapData as any,
        256,
        1,
        THREE.RGBAFormat,
        THREE.UnsignedByteType
      );
      this.colormapTexture.needsUpdate = true;
      this.trackResource(this.colormapTexture, 'texture', 'Updated colormap texture');
      
      if (this.volumeMaterial) {
        this.volumeMaterial.uniforms.uColormap.value = this.colormapTexture;
        this.volumeMaterial.needsUpdate = true;
      }
    }
  }
  
  getSettings(): VolumeRenderSettings {
    return { ...this.settings };
  }
  
  getValueRange(): { min: number; max: number } {
    return { ...this.valueRange };
  }
  
  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }
  
  getControls(): OrbitControls {
    return this.controls;
  }
  
  getScene(): THREE.Scene {
    return this.scene;
  }
  
  getOctreeScheduler(): OctreeScheduler {
    return this.octreeScheduler;
  }
  
  getColormapManager(): ColormapManager {
    return this.colormapManager;
  }
  
  getGroupId(): string {
    return this.groupId;
  }
  
  resetCamera(): void {
    this.updateCameraPosition();
  }
  
  getMemoryUsage(): number {
    let total = 0;
    
    if (this.volumeData) {
      total += this.volumeData.byteLength;
    }
    
    for (const [, block] of this.blocks) {
      total += block.amplitude_data.byteLength;
    }
    
    return total;
  }
  
  getFps(): number {
    return this.fpsCounter.currentFps;
  }
  
  enableClipping(enable: boolean): void {
    if (this.isDisposed) return;
    
    this.clippingEnabled = enable;
    
    if (this.planeInteractor) {
      this.planeInteractor.enabled = enable;
      this.planeInteractor.visible = enable;
    }
    
    if (this.volumeMaterial) {
      this.volumeMaterial.uniforms.uEnableClipping.value = enable;
    }
    
    if (enable && this.planeInteractor) {
      this.updateClipPlaneUniforms(this.planeInteractor.plane);
    }
  }
  
  isClippingEnabled(): boolean {
    return this.clippingEnabled;
  }
  
  getPlaneInteractor(): PlaneInteractor | null {
    return this.planeInteractor;
  }
  
  setClipPlaneNormal(normal: THREE.Vector3): void {
    if (!this.planeInteractor || this.isDisposed) return;
    
    const plane = this.planeInteractor.plane;
    plane.setNormal(normal);
    this.updateClipPlaneUniforms(plane);
  }
  
  setClipPlaneOffset(offset: number): void {
    if (!this.planeInteractor || this.isDisposed) return;
    
    const plane = this.planeInteractor.plane;
    const center = new THREE.Vector3();
    if (this.volumeMesh) {
      const box = new THREE.Box3().setFromObject(this.volumeMesh);
      box.getCenter(center);
    }
    
    plane.setFromNormalAndCoplanarPoint(
      plane.normal,
      center.clone().add(plane.normal.clone().multiplyScalar(offset))
    );
    
    this.updateClipPlaneUniforms(plane);
  }
  
  resetClipPlane(): void {
    if (!this.planeInteractor || this.isDisposed) return;
    
    this.planeInteractor.reset();
    this.updateClipPlaneUniforms(this.planeInteractor.plane);
  }
  
  async dispose(): Promise<void> {
    if (this.isDisposed) return;
    this.isDisposed = true;
    
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    
    window.removeEventListener('resize', this.handleResize);
    
    if (this.planeInteractor) {
      await this.planeInteractor.dispose();
      this.planeInteractor = null;
    }
    
    await this.clearVolumeData();
    
    if (this.colormapTexture) {
      this.disposeTexture(this.colormapTexture);
      this.colormapTexture = null;
    }
    
    for (const light of this.lights) {
      try {
        this.scene.remove(light);
      } catch {}
    }
    this.lights = [];
    
    try {
      this.controls.dispose();
    } catch (error) {
      console.warn('[VolumeRenderer] Controls dispose warning:', error);
    }
    
    while (this.scene.children.length > 0) {
      this.scene.remove(this.scene.children[0]);
    }
    
    try {
      this.renderer.dispose();
      const gl = this.renderer.getContext();
      if (gl) {
        const loseContext = gl.getExtension('WEBGL_lose_context');
        if (loseContext) {
          loseContext.loseContext();
        }
      }
    } catch (error) {
      console.warn('[VolumeRenderer] Renderer dispose warning:', error);
    }
    
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
    
    this.trackedResources.clear();
    
    resourceManager.unregisterCleanupHook(`renderer_${this.groupId}`);
    await resourceManager.disposeGroup(this.groupId, true);
    await resourceManager.forceGC();
    
    console.log(`[VolumeRenderer] Disposed ${this.groupId}`);
  }
}
