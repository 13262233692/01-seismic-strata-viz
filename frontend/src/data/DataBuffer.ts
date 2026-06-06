import { DataBlock, WebSocketMessage, MessageType, SEGYHeader, DatasetMetadata, ProgressUpdate } from '../types';
import pako from 'pako';
import { resourceManager } from '../utils/ResourceManager';

type MessageCallback = (message: WebSocketMessage) => void;
type BlockCallback = (block: DataBlock) => void;
type HeaderCallback = (header: SEGYHeader) => void;
type MetadataCallback = (metadata: DatasetMetadata) => void;
type ProgressCallback = (progress: ProgressUpdate) => void;
type ErrorCallback = (error: string) => void;

export class DataBuffer {
  private blocks: Map<string, { data: Float32Array; resourceId: string }> = new Map();
  private compressedBlocks: Map<string, { data: Uint8Array; resourceId: string }> = new Map();
  private maxBlocks: number = 100;
  private accessOrder: string[] = [];
  private groupId: string;
  private isDisposed = false;

  constructor(maxBlocks: number = 100, groupId?: string) {
    this.maxBlocks = maxBlocks;
    this.groupId = groupId || `databuffer_${Date.now()}`;
    resourceManager.registerCleanupHook(`databuffer_${this.groupId}`, () => this.dispose());
  }

  addBlock(block: DataBlock): void {
    if (this.isDisposed) return;
    
    const decompressed = this.decompressBlock(block.amplitude_data);
    
    const floatData = new Float32Array(
      decompressed.buffer.slice(
        decompressed.byteOffset,
        decompressed.byteOffset + decompressed.byteLength
      )
    );
    
    const floatResourceId = resourceManager.track(
      floatData,
      'Float32Array',
      floatData.byteLength,
      this.groupId,
      `Volume block: ${block.block_id}`
    );
    
    const compressedResourceId = resourceManager.track(
      block.amplitude_data,
      'Uint8Array',
      block.amplitude_data.byteLength,
      this.groupId,
      `Compressed block: ${block.block_id}`
    );

    if (this.blocks.size >= this.maxBlocks) {
      this.evictOldest();
    }

    this.blocks.set(block.block_id, { data: floatData, resourceId: floatResourceId });
    this.compressedBlocks.set(block.block_id, { data: block.amplitude_data, resourceId: compressedResourceId });
    this.updateAccessOrder(block.block_id);
  }

  getBlock(blockId: string): Float32Array | undefined {
    const entry = this.blocks.get(blockId);
    if (entry) {
      this.updateAccessOrder(blockId);
      return entry.data;
    }
    return undefined;
  }

  getCompressedBlock(blockId: string): Uint8Array | undefined {
    return this.compressedBlocks.get(blockId)?.data;
  }

  hasBlock(blockId: string): boolean {
    return this.blocks.has(blockId);
  }

  async clear(): Promise<void> {
    for (const [, entry] of this.blocks) {
      await resourceManager.dispose(entry.resourceId, true);
    }
    for (const [, entry] of this.compressedBlocks) {
      await resourceManager.dispose(entry.resourceId, true);
    }
    
    this.blocks.clear();
    this.compressedBlocks.clear();
    this.accessOrder = [];
    
    await resourceManager.forceGC();
  }

  async dispose(): Promise<void> {
    if (this.isDisposed) return;
    this.isDisposed = true;
    
    await this.clear();
    resourceManager.unregisterCleanupHook(`databuffer_${this.groupId}`);
    
    if (typeof (globalThis as any).gc === 'function') {
      (globalThis as any).gc();
    }
  }

  get size(): number {
    return this.blocks.size;
  }

  getMemoryUsage(): number {
    let total = 0;
    for (const [, entry] of this.blocks) {
      total += entry.data.byteLength;
    }
    for (const [, entry] of this.compressedBlocks) {
      total += entry.data.byteLength;
    }
    return total;
  }

  getGroupId(): string {
    return this.groupId;
  }

  private decompressBlock(data: Uint8Array): Uint8Array {
    try {
      return pako.inflate(data);
    } catch {
      return data;
    }
  }

  private updateAccessOrder(blockId: string): void {
    const idx = this.accessOrder.indexOf(blockId);
    if (idx > -1) {
      this.accessOrder.splice(idx, 1);
    }
    this.accessOrder.push(blockId);
  }

  private evictOldest(): void {
    if (this.accessOrder.length > 0) {
      const oldest = this.accessOrder.shift();
      if (oldest) {
        this.removeBlock(oldest);
      }
    }
  }

  private async removeBlock(blockId: string): Promise<void> {
    const floatEntry = this.blocks.get(blockId);
    const compressedEntry = this.compressedBlocks.get(blockId);
    
    if (floatEntry) {
      await resourceManager.dispose(floatEntry.resourceId, true);
      this.blocks.delete(blockId);
    }
    
    if (compressedEntry) {
      await resourceManager.dispose(compressedEntry.resourceId, true);
      this.compressedBlocks.delete(blockId);
    }
  }
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private clientId: string;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectDelay: number = 1000;
  private url: string;
  private isManuallyDisconnected = false;
  
  private messageCallbacks: Set<MessageCallback> = new Set();
  private blockCallbacks: Set<BlockCallback> = new Set();
  private headerCallbacks: Set<HeaderCallback> = new Set();
  private metadataCallbacks: Set<MetadataCallback> = new Set();
  private progressCallbacks: Set<ProgressCallback> = new Set();
  private errorCallbacks: Set<ErrorCallback> = new Set();
  
  public dataBuffer: DataBuffer;
  private groupId: string;
  private messageQueue: WebSocketMessage[] = [];
  private isProcessingQueue = false;
  private isDisposed = false;

  constructor(serverUrl: string, clientId?: string) {
    this.url = serverUrl;
    this.clientId = clientId || this.generateClientId();
    this.groupId = `ws_${this.clientId}`;
    this.dataBuffer = new DataBuffer(100, this.groupId);
    
    resourceManager.registerCleanupHook(`wsclient_${this.clientId}`, () => this.dispose());
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isDisposed) {
        reject(new Error('Client has been disposed'));
        return;
      }
      
      try {
        const wsUrl = `${this.url}/ws/${this.clientId}`;
        this.ws = new WebSocket(wsUrl);
        this.ws.binaryType = 'arraybuffer';
        this.isManuallyDisconnected = false;

        this.ws.onopen = () => {
          console.log(`[WebSocket] Connected to ${wsUrl}`);
          this.reconnectAttempts = 0;
          this.processQueue();
          resolve();
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.ws.onerror = (error) => {
          console.error('[WebSocket] Error:', error);
          this.errorCallbacks.forEach(cb => cb('WebSocket connection error'));
          if (this.ws?.readyState !== WebSocket.OPEN) {
            reject(error);
          }
        };

        this.ws.onclose = () => {
          console.log('[WebSocket] Connection closed');
          if (!this.isManuallyDisconnected && !this.isDisposed) {
            this.handleReconnect();
          }
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  async disconnect(): Promise<void> {
    this.isManuallyDisconnected = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.messageQueue = [];
  }

  send(message: WebSocketMessage): void {
    if (this.isDisposed) return;
    
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(this.serializeMessage(message));
    } else {
      this.messageQueue.push(message);
      if (this.messageQueue.length > 100) {
        this.messageQueue.shift();
      }
    }
  }

  requestBlocks(datasetId: string, blockIds: string[], stream: boolean = true): void {
    const message: WebSocketMessage = {
      type: MessageType.REQUEST_BLOCK,
      request_id: datasetId,
      block_request: {
        block_ids: blockIds,
        level: 0,
        stream: stream,
      },
    };
    this.send(message);
  }

  requestMetadata(datasetId: string): void {
    const message: WebSocketMessage = {
      type: MessageType.METADATA,
      request_id: datasetId,
    };
    this.send(message);
  }

  sendViewFrustum(datasetId: string, frustum: {
    matrix: number[];
    fov: number;
    aspect: number;
    near: number;
    far: number;
  }): void {
    const message: WebSocketMessage = {
      type: MessageType.VIEW_FRUSTUM,
      request_id: datasetId,
      view_frustum: frustum,
    };
    this.send(message);
  }

  onMessage(callback: MessageCallback): () => void {
    this.messageCallbacks.add(callback);
    return () => this.messageCallbacks.delete(callback);
  }

  onBlock(callback: BlockCallback): () => void {
    this.blockCallbacks.add(callback);
    return () => this.blockCallbacks.delete(callback);
  }

  onHeader(callback: HeaderCallback): () => void {
    this.headerCallbacks.add(callback);
    return () => this.headerCallbacks.delete(callback);
  }

  onMetadata(callback: MetadataCallback): () => void {
    this.metadataCallbacks.add(callback);
    return () => this.metadataCallbacks.delete(callback);
  }

  onProgress(callback: ProgressCallback): () => void {
    this.progressCallbacks.add(callback);
    return () => this.progressCallbacks.delete(callback);
  }

  onError(callback: ErrorCallback): () => void {
    this.errorCallbacks.add(callback);
    return () => this.errorCallbacks.delete(callback);
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.isDisposed) return;
    this.isProcessingQueue = true;
    
    while (this.messageQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      const msg = this.messageQueue.shift();
      if (msg) {
        this.ws.send(this.serializeMessage(msg));
      }
    }
    
    this.isProcessingQueue = false;
  }

  private handleMessage(data: ArrayBuffer | string): void {
    if (this.isDisposed) return;
    
    try {
      let message: WebSocketMessage;
      
      if (typeof data === 'string') {
        message = JSON.parse(data) as WebSocketMessage;
      } else {
        const bytes = new Uint8Array(data);
        const text = new TextDecoder('utf-8').decode(bytes);
        message = JSON.parse(text) as WebSocketMessage;
      }

      this.messageCallbacks.forEach(cb => cb(message));

      switch (message.type) {
        case MessageType.HEADER:
          if (message.header) {
            this.headerCallbacks.forEach(cb => cb(message.header!));
          }
          break;

        case MessageType.DATA_BLOCK:
          if (message.data_block) {
            message.data_block.amplitude_data = new Uint8Array(
              message.data_block.amplitude_data as unknown as number[]
            );
            this.dataBuffer.addBlock(message.data_block);
            this.blockCallbacks.forEach(cb => cb(message.data_block!));
          }
          break;

        case MessageType.METADATA:
          if (message.metadata) {
            this.metadataCallbacks.forEach(cb => cb(message.metadata!));
          }
          break;

        case MessageType.PROGRESS:
          if (message.progress) {
            this.progressCallbacks.forEach(cb => cb(message.progress!));
          }
          break;

        case MessageType.ERROR:
          if (message.error) {
            this.errorCallbacks.forEach(cb => cb(message.error!.message));
          }
          break;

        case MessageType.COMPLETE:
          console.log('[WebSocket] Transfer complete');
          break;
      }
    } catch (error) {
      console.error('[WebSocket] Failed to parse message:', error);
    }
  }

  private serializeMessage(message: WebSocketMessage): ArrayBuffer {
    const json = JSON.stringify(message);
    return new TextEncoder().encode(json).buffer;
  }

  private handleReconnect(): void {
    if (this.isDisposed || this.isManuallyDisconnected) return;
    
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
      console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
      
      setTimeout(() => {
        if (!this.isDisposed && !this.isManuallyDisconnected) {
          this.connect().catch(() => {});
        }
      }, delay);
    } else {
      console.error('[WebSocket] Max reconnect attempts reached');
      this.errorCallbacks.forEach(cb => cb('Failed to reconnect after multiple attempts'));
    }
  }

  private generateClientId(): string {
    return 'client_' + Math.random().toString(36).substr(2, 9);
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getClientId(): string {
    return this.clientId;
  }

  getGroupId(): string {
    return this.groupId;
  }

  getMemoryUsage(): number {
    return this.dataBuffer.getMemoryUsage();
  }

  async dispose(): Promise<void> {
    if (this.isDisposed) return;
    this.isDisposed = true;
    
    this.isManuallyDisconnected = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.messageCallbacks.clear();
    this.blockCallbacks.clear();
    this.headerCallbacks.clear();
    this.metadataCallbacks.clear();
    this.progressCallbacks.clear();
    this.errorCallbacks.clear();
    this.messageQueue = [];
    
    await this.dataBuffer.dispose();
    
    resourceManager.unregisterCleanupHook(`wsclient_${this.clientId}`);
    
    await resourceManager.disposeGroup(this.groupId, true);
    await resourceManager.forceGC();
    
    console.log(`[WebSocketClient] Disposed client ${this.clientId}`);
  }
}
