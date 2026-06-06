import * as THREE from 'three';
import { BlockInfo, BoundingBox } from '../types';

interface OctreeNode {
  id: string;
  level: number;
  bounds: THREE.Box3;
  children: OctreeNode[];
  parent: OctreeNode | null;
  blockInfo: BlockInfo | null;
  isLoaded: boolean;
}

export class OctreeScheduler {
  private root: OctreeNode | null = null;
  private nodes: Map<string, OctreeNode> = new Map();
  private loadedBlocks: Set<string> = new Set();
  private visibleBlocks: Set<string> = new Set();
  private pendingRequests: Set<string> = new Set();
  
  private maxLoadedBlocks: number = 100;
  
  private frustum: THREE.Frustum = new THREE.Frustum();
  
  constructor() {}

  buildFromBlocks(blocks: BlockInfo[], header: any): OctreeNode {
    this.nodes.clear();
    this.loadedBlocks.clear();
    this.visibleBlocks.clear();
    this.pendingRequests.clear();
    
    const globalBounds = this.computeGlobalBounds(header);
    this.root = this.buildOctreeRecursive(blocks, globalBounds, 0, null);
    
    return this.root;
  }

  private computeGlobalBounds(header: any): THREE.Box3 {
    return new THREE.Box3(
      new THREE.Vector3(header.min_x, header.min_y, header.min_z),
      new THREE.Vector3(header.max_x, header.max_y, header.max_z)
    );
  }

  private buildOctreeRecursive(
    blocks: BlockInfo[],
    bounds: THREE.Box3,
    level: number,
    parent: OctreeNode | null
  ): OctreeNode {
    const nodeId = this.generateNodeId(bounds, level);
    
    const node: OctreeNode = {
      id: nodeId,
      level: level,
      bounds: bounds.clone(),
      children: [],
      parent: parent,
      blockInfo: null,
      isLoaded: false,
    };
    
    this.nodes.set(nodeId, node);
    
    const blocksInNode = blocks.filter(b => this.isBlockInBounds(b, bounds));
    
    if (blocksInNode.length === 1 && level >= 1) {
      node.blockInfo = blocksInNode[0];
      return node;
    }
    
    if (blocksInNode.length <= 1 || level >= 5) {
      if (blocksInNode.length > 0) {
        node.blockInfo = blocksInNode[0];
      }
      return node;
    }
    
    const children = this.splitBounds(bounds);
    node.children = children.map(childBounds => 
      this.buildOctreeRecursive(blocksInNode, childBounds, level + 1, node)
    );
    
    return node;
  }

  private isBlockInBounds(block: BlockInfo, bounds: THREE.Box3): boolean {
    const bb = block.bounding_box;
    const blockCenter = new THREE.Vector3(
      (bb.min_x + bb.max_x) / 2,
      (bb.min_y + bb.max_y) / 2,
      (bb.min_z + bb.max_z) / 2
    );
    return bounds.containsPoint(blockCenter);
  }

  private splitBounds(bounds: THREE.Box3): THREE.Box3[] {
    const center = new THREE.Vector3();
    bounds.getCenter(center);
    
    const min = bounds.min;
    const max = bounds.max;
    
    const midX = center.x;
    const midY = center.y;
    const midZ = center.z;
    
    return [
      new THREE.Box3(
        new THREE.Vector3(min.x, min.y, min.z),
        new THREE.Vector3(midX, midY, midZ)
      ),
      new THREE.Box3(
        new THREE.Vector3(midX, min.y, min.z),
        new THREE.Vector3(max.x, midY, midZ)
      ),
      new THREE.Box3(
        new THREE.Vector3(min.x, midY, min.z),
        new THREE.Vector3(midX, max.y, midZ)
      ),
      new THREE.Box3(
        new THREE.Vector3(midX, midY, min.z),
        new THREE.Vector3(max.x, max.y, midZ)
      ),
      new THREE.Box3(
        new THREE.Vector3(min.x, min.y, midZ),
        new THREE.Vector3(midX, midY, max.z)
      ),
      new THREE.Box3(
        new THREE.Vector3(midX, min.y, midZ),
        new THREE.Vector3(max.x, midY, max.z)
      ),
      new THREE.Box3(
        new THREE.Vector3(min.x, midY, midZ),
        new THREE.Vector3(midX, max.y, max.z)
      ),
      new THREE.Box3(
        new THREE.Vector3(midX, midY, midZ),
        new THREE.Vector3(max.x, max.y, max.z)
      ),
    ];
  }

  private generateNodeId(bounds: THREE.Box3, level: number): string {
    const center = new THREE.Vector3();
    bounds.getCenter(center);
    return `node_${level}_${center.x.toFixed(2)}_${center.y.toFixed(2)}_${center.z.toFixed(2)}`;
  }

  updateVisibility(camera: THREE.Camera): string[] {
    this.updateFrustum(camera);
    
    this.visibleBlocks.clear();
    this.collectVisibleBlocks(this.root, this.frustum);
    
    return Array.from(this.visibleBlocks);
  }

  private updateFrustum(camera: THREE.Camera): void {
    const projScreenMatrix = new THREE.Matrix4();
    projScreenMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse
    );
    
    this.frustum.setFromProjectionMatrix(projScreenMatrix);
  }

  private collectVisibleBlocks(node: OctreeNode | null, frustum: THREE.Frustum): void {
    if (!node) return;
    
    if (!frustum.intersectsBox(node.bounds)) {
      return;
    }
    
    if (node.blockInfo) {
      this.visibleBlocks.add(node.blockInfo.block_id);
    }
    
    for (const child of node.children) {
      this.collectVisibleBlocks(child, frustum);
    }
  }

  getBlocksToRequest(maxRequests: number = 10): string[] {
    const toRequest: string[] = [];
    
    for (const blockId of this.visibleBlocks) {
      if (!this.loadedBlocks.has(blockId) && !this.pendingRequests.has(blockId)) {
        toRequest.push(blockId);
        if (toRequest.length >= maxRequests) {
          break;
        }
      }
    }
    
    toRequest.forEach(id => this.pendingRequests.add(id));
    
    return toRequest;
  }

  markBlockLoaded(blockId: string): void {
    this.loadedBlocks.add(blockId);
    this.pendingRequests.delete(blockId);
    
    if (this.loadedBlocks.size > this.maxLoadedBlocks) {
      this.evictUnusedBlocks();
    }
  }

  private evictUnusedBlocks(): void {
    const toEvict: string[] = [];
    
    for (const blockId of this.loadedBlocks) {
      if (!this.visibleBlocks.has(blockId)) {
        toEvict.push(blockId);
      }
    }
    
    toEvict.sort(() => Math.random() - 0.5);
    
    while (this.loadedBlocks.size > this.maxLoadedBlocks * 0.8 && toEvict.length > 0) {
      const evictId = toEvict.pop();
      if (evictId) {
        this.loadedBlocks.delete(evictId);
      }
    }
  }

  isBlockLoaded(blockId: string): boolean {
    return this.loadedBlocks.has(blockId);
  }

  isBlockVisible(blockId: string): boolean {
    return this.visibleBlocks.has(blockId);
  }

  getLoadedBlocks(): string[] {
    return Array.from(this.loadedBlocks);
  }

  getVisibleBlocks(): string[] {
    return Array.from(this.visibleBlocks);
  }

  getNode(blockId: string): OctreeNode | null {
    for (const node of this.nodes.values()) {
      if (node.blockInfo?.block_id === blockId) {
        return node;
      }
    }
    return null;
  }

  getBlockBounds(blockId: string): THREE.Box3 | null {
    const node = this.getNode(blockId);
    return node ? node.bounds.clone() : null;
  }

  getRoot(): OctreeNode | null {
    return this.root;
  }

  clear(): void {
    this.root = null;
    this.nodes.clear();
    this.loadedBlocks.clear();
    this.visibleBlocks.clear();
    this.pendingRequests.clear();
  }

  static computeBoundingBox(bb: BoundingBox): THREE.Box3 {
    return new THREE.Box3(
      new THREE.Vector3(bb.min_x, bb.min_y, bb.min_z),
      new THREE.Vector3(bb.max_x, bb.max_y, bb.max_z)
    );
  }
}
