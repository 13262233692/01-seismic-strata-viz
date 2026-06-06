import * as THREE from 'three';

export interface Disposable {
  dispose: () => void;
}

export interface TrackedResource {
  id: string;
  type: string;
  resource: any;
  size: number;
  createdAt: number;
  description?: string;
}

type ResourceCleanupHook = () => Promise<void> | void;

export class ResourceManager {
  private static instance: ResourceManager | null = null;
  
  private resources: Map<string, TrackedResource> = new Map();
  private cleanupHooks: Map<string, ResourceCleanupHook> = new Map();
  private groupResources: Map<string, Set<string>> = new Map();
  
  private memoryStats = {
    totalAllocated: 0,
    totalFreed: 0,
    peakUsage: 0,
  };
  
  private debugMode = false;
  
  private constructor() {}
  
  static getInstance(): ResourceManager {
    if (!ResourceManager.instance) {
      ResourceManager.instance = new ResourceManager();
    }
    return ResourceManager.instance;
  }
  
  enableDebug(enable: boolean): void {
    this.debugMode = enable;
  }
  
  track(
    resource: any,
    type: string,
    size: number = 0,
    group?: string,
    description?: string
  ): string {
    const id = `res_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const tracked: TrackedResource = {
      id,
      type,
      resource,
      size,
      createdAt: Date.now(),
      description,
    };
    
    this.resources.set(id, tracked);
    this.memoryStats.totalAllocated += size;
    this.memoryStats.peakUsage = Math.max(
      this.memoryStats.peakUsage,
      this.memoryStats.totalAllocated - this.memoryStats.totalFreed
    );
    
    if (group) {
      if (!this.groupResources.has(group)) {
        this.groupResources.set(group, new Set());
      }
      this.groupResources.get(group)!.add(id);
    }
    
    if (this.debugMode) {
      console.log(`[ResourceManager] Tracked: ${type} (${id}), size: ${size} bytes`);
    }
    
    return id;
  }
  
  untrack(id: string): void {
    const resource = this.resources.get(id);
    if (resource) {
      this.memoryStats.totalFreed += resource.size;
      this.resources.delete(id);
      
      for (const [, ids] of this.groupResources) {
        ids.delete(id);
      }
      
      if (this.debugMode) {
        console.log(`[ResourceManager] Untracked: ${resource.type} (${id})`);
      }
    }
  }
  
  async dispose(id: string, force: boolean = false): Promise<boolean> {
    const tracked = this.resources.get(id);
    if (!tracked) {
      return false;
    }
    
    try {
      await this.disposeResource(tracked.resource);
      this.untrack(id);
      return true;
    } catch (error) {
      console.error(`[ResourceManager] Failed to dispose ${tracked.type}:`, error);
      if (force) {
        this.untrack(id);
      }
      return force;
    }
  }
  
  private async disposeResource(resource: any): Promise<void> {
    if (!resource) return;
    
    if (resource.dispose && typeof resource.dispose === 'function') {
      await resource.dispose();
      return;
    }
    
    if (resource instanceof THREE.BufferGeometry) {
      resource.dispose();
      return;
    }
    
    if (resource instanceof THREE.Material) {
      resource.dispose();
      return;
    }
    
    if (resource instanceof THREE.Texture) {
      resource.dispose();
      return;
    }
    
    if (resource instanceof THREE.WebGLRenderer) {
      resource.dispose();
      return;
    }
    
    if (resource.buffer && resource.buffer instanceof ArrayBuffer) {
      const buf = resource.buffer as any;
      if (typeof buf.transfer === 'function') {
        buf.transfer();
      }
    }
    
    if (resource instanceof ArrayBuffer) {
      const buf = resource as any;
      if (typeof buf.transfer === 'function') {
        buf.transfer();
      }
    }
  }
  
  async disposeGroup(group: string, force: boolean = false): Promise<number> {
    const resourceIds = this.groupResources.get(group);
    if (!resourceIds) {
      return 0;
    }
    
    let disposed = 0;
    const ids = Array.from(resourceIds);
    
    for (const id of ids) {
      if (await this.dispose(id, force)) {
        disposed++;
      }
    }
    
    this.groupResources.delete(group);
    
    if (this.debugMode) {
      console.log(`[ResourceManager] Disposed group '${group}': ${disposed} resources`);
    }
    
    return disposed;
  }
  
  registerCleanupHook(id: string, hook: ResourceCleanupHook): void {
    this.cleanupHooks.set(id, hook);
  }
  
  unregisterCleanupHook(id: string): void {
    this.cleanupHooks.delete(id);
  }
  
  async runCleanupHooks(): Promise<void> {
    const hooks = Array.from(this.cleanupHooks.values());
    for (const hook of hooks) {
      try {
        await hook();
      } catch (error) {
        console.error('[ResourceManager] Cleanup hook error:', error);
      }
    }
    this.cleanupHooks.clear();
  }
  
  async forceGC(): Promise<void> {
    if (typeof (globalThis as any).gc === 'function') {
      (globalThis as any).gc();
    }
    
    await this.runCleanupHooks();
    
    if (this.debugMode) {
      console.log('[ResourceManager] Force GC triggered');
    }
  }
  
  async disposeAll(force: boolean = false): Promise<number> {
    let disposed = 0;
    const ids = Array.from(this.resources.keys());
    
    for (const id of ids) {
      if (await this.dispose(id, force)) {
        disposed++;
      }
    }
    
    this.groupResources.clear();
    await this.forceGC();
    
    return disposed;
  }
  
  getStats() {
    const currentUsage = this.memoryStats.totalAllocated - this.memoryStats.totalFreed;
    
    return {
      ...this.memoryStats,
      currentUsage,
      resourceCount: this.resources.size,
      groupCount: this.groupResources.size,
      byType: this.getResourceCountsByType(),
    };
  }
  
  private getResourceCountsByType(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const res of this.resources.values()) {
      counts[res.type] = (counts[res.type] || 0) + 1;
    }
    return counts;
  }
  
  getGroupStats(group: string) {
    const ids = this.groupResources.get(group);
    if (!ids) return null;
    
    let totalSize = 0;
    const byType: Record<string, number> = {};
    
    for (const id of ids) {
      const res = this.resources.get(id);
      if (res) {
        totalSize += res.size;
        byType[res.type] = (byType[res.type] || 0) + 1;
      }
    }
    
    return {
      count: ids.size,
      totalSize,
      byType,
    };
  }
  
  createTypedArrayWithTracking(
    constructor: typeof Float32Array | typeof Uint8Array | typeof Uint16Array | typeof Int16Array | typeof Int32Array,
    length: number,
    type: string,
    group?: string
  ) {
    const array = new constructor(length);
    const size = length * constructor.BYTES_PER_ELEMENT;
    this.track(array, type, size, group, `${constructor.name}[${length}]`);
    return array;
  }
  
  freeTypedArray(array: any): void {
    if (!array) return;
    
    for (const [id, tracked] of this.resources) {
      if (tracked.resource === array) {
        this.dispose(id, true);
        return;
      }
    }
  }
  
  async safeSwitch(
    groupToDispose: string,
    _newGroupId: string,
    creationFn: () => Promise<void>,
    waitMs: number = 100
  ): Promise<void> {
    await this.disposeGroup(groupToDispose, true);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    await this.forceGC();
    await new Promise(resolve => setTimeout(resolve, waitMs));
    await creationFn();
  }
}

export const resourceManager = ResourceManager.getInstance();
