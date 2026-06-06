import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DataBlock, VolumeRenderSettings, SEGYHeader } from '../types';
import { ColormapManager } from './ColormapManager';
import { OctreeScheduler } from './OctreeScheduler';

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

varying vec3 vWorldPosition;
varying vec3 vLocalPosition;
varying vec2 vUv;

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
  
  private colormapManager: ColormapManager;
  private octreeScheduler: OctreeScheduler;
  
  private settings: VolumeRenderSettings;
  private header: SEGYHeader | null = null;
  private volumeData: Float32Array | null = null;
  private volumeDimensions: { width: number; height: number; depth: number } = { width: 0, height: 0, depth: 0 };
  private valueRange: { min: number; max: number } = { min: 0, max: 1 };
  
  private blocks: Map<string, DataBlock> = new Map();
  
  constructor(options: VolumeRendererOptions) {
    this.container = options.container;
    this.colormapManager = new ColormapManager();
    this.octreeScheduler = new OctreeScheduler();
    
    this.settings = {
      colormap: options.settings?.colormap || this.colormapManager.getDefaultColormap(),
      sampleRate: options.settings?.sampleRate || 1.0,
      opacity: options.settings?.opacity || 0.5,
      brightness: options.settings?.brightness || 0.0,
      contrast: options.settings?.contrast || 1.0,
      threshold: options.settings?.threshold || 0.0,
    };
    
    this.init();
  }
  
  private init(): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0a0f);
    
    const { clientWidth, clientHeight } = this.container;
    
    this.camera = new THREE.PerspectiveCamera(
      60,
      clientWidth / clientHeight,
      0.1,
      10000
    );
    this.camera.position.set(100, 100, 100);
    
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(clientWidth, clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.sortObjects = false;
    
    this.container.appendChild(this.renderer.domElement);
    
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxPolarAngle = Math.PI / 2.1;
    
    this.setupLights();
    this.setupColormapTexture();
    this.setupEventListeners();
    this.animate();
  }
  
  private setupLights(): void {
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(ambientLight);
    
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(1, 1, 1);
    this.scene.add(directionalLight);
  }
  
  private setupColormapTexture(): void {
    const colormapData = this.colormapManager.createColormapTexture(this.settings.colormap);
    this.colormapTexture = new THREE.DataTexture(
      colormapData as any,
      256,
      1,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    );
    this.colormapTexture.needsUpdate = true;
  }
  
  private setupEventListeners(): void {
    window.addEventListener('resize', this.handleResize);
  }
  
  private handleResize = (): void => {
    const { clientWidth, clientHeight } = this.container;
    
    this.camera.aspect = clientWidth / clientHeight;
    this.camera.updateProjectionMatrix();
    
    this.renderer.setSize(clientWidth, clientHeight);
  };
  
  private animate = (): void => {
    this.animationFrameId = requestAnimationFrame(this.animate);
    this.controls.update();
    this.updateUniforms();
    this.render();
  };
  
  private render(): void {
    this.renderer.render(this.scene, this.camera);
  }
  
  private updateUniforms(): void {
    if (!this.volumeMaterial) return;
    
    const uniforms = this.volumeMaterial.uniforms;
    
    uniforms.uCameraPos.value.copy(this.camera.position);
    uniforms.uSampleRate.value = this.settings.sampleRate;
    uniforms.uOpacity.value = this.settings.opacity;
    uniforms.uBrightness.value = this.settings.brightness;
    uniforms.uContrast.value = this.settings.contrast;
    uniforms.uThreshold.value = this.settings.threshold;
  }
  
  setHeader(header: SEGYHeader): void {
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
    this.volumeData = data;
    this.volumeDimensions = { width, height, depth };
    this.header = header;
    
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < data.length; i++) {
      if (data[i] < min) min = data[i];
      if (data[i] > max) max = data[i];
    }
    this.valueRange = { min, max };
    
    this.createVolumeTexture();
    this.createVolumeMesh();
    this.updateCameraPosition();
  }
  
  private createVolumeTexture(): void {
    if (!this.volumeData) return;
    
    const { width, height, depth } = this.volumeDimensions;
    
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
  }
  
  private createVolumeMesh(): void {
    if (this.volumeMesh) {
      this.scene.remove(this.volumeMesh);
      this.volumeMesh.geometry.dispose();
      if (this.volumeMaterial) {
        this.volumeMaterial.dispose();
      }
    }
    
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    
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
  }
  
  private updateCameraPosition(): void {
    if (!this.header || !this.volumeMesh) return;
    
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
    this.settings = { ...this.settings, ...settings };
    
    if (settings.colormap) {
      const colormapData = this.colormapManager.createColormapTexture(settings.colormap);
      if (this.colormapTexture) {
        this.colormapTexture.dispose();
      }
      this.colormapTexture = new THREE.DataTexture(
        colormapData as any,
        256,
        1,
        THREE.RGBAFormat,
        THREE.UnsignedByteType
      );
      this.colormapTexture.needsUpdate = true;
      
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
  
  resetCamera(): void {
    this.updateCameraPosition();
  }
  
  dispose(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    
    window.removeEventListener('resize', this.handleResize);
    
    if (this.volumeMesh) {
      this.scene.remove(this.volumeMesh);
      this.volumeMesh.geometry.dispose();
      if (this.volumeMaterial) {
        this.volumeMaterial.dispose();
      }
    }
    
    if (this.volumeTexture) {
      this.volumeTexture.dispose();
    }
    
    if (this.colormapTexture) {
      this.colormapTexture.dispose();
    }
    
    this.controls.dispose();
    this.renderer.dispose();
    
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}
