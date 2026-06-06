import { DataBlock, WebSocketMessage, MessageType, SEGYHeader, DatasetMetadata, ProgressUpdate } from '../types';
import pako from 'pako';

type MessageCallback = (message: WebSocketMessage) => void;
type BlockCallback = (block: DataBlock) => void;
type HeaderCallback = (header: SEGYHeader) => void;
type MetadataCallback = (metadata: DatasetMetadata) => void;
type ProgressCallback = (progress: ProgressUpdate) => void;
type ErrorCallback = (error: string) => void;

export class DataBuffer {
  private blocks: Map<string, Float32Array> = new Map();
  private compressedBlocks: Map<string, Uint8Array> = new Map();
  private maxBlocks: number = 100;
  private accessOrder: string[] = [];

  constructor(maxBlocks: number = 100) {
    this.maxBlocks = maxBlocks;
  }

  addBlock(block: DataBlock): void {
    const decompressed = this.decompressBlock(block.amplitude_data);
    const floatData = new Float32Array(
      decompressed.buffer,
      decompressed.byteOffset,
      decompressed.byteLength / 4
    );

    if (this.blocks.size >= this.maxBlocks) {
      this.evictOldest();
    }

    this.blocks.set(block.block_id, floatData);
    this.compressedBlocks.set(block.block_id, block.amplitude_data);
    this.updateAccessOrder(block.block_id);
  }

  getBlock(blockId: string): Float32Array | undefined {
    const block = this.blocks.get(blockId);
    if (block) {
      this.updateAccessOrder(blockId);
    }
    return block;
  }

  getCompressedBlock(blockId: string): Uint8Array | undefined {
    return this.compressedBlocks.get(blockId);
  }

  hasBlock(blockId: string): boolean {
    return this.blocks.has(blockId);
  }

  clear(): void {
    this.blocks.clear();
    this.compressedBlocks.clear();
    this.accessOrder = [];
  }

  get size(): number {
    return this.blocks.size;
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
        this.blocks.delete(oldest);
        this.compressedBlocks.delete(oldest);
      }
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
  
  private messageCallbacks: Set<MessageCallback> = new Set();
  private blockCallbacks: Set<BlockCallback> = new Set();
  private headerCallbacks: Set<HeaderCallback> = new Set();
  private metadataCallbacks: Set<MetadataCallback> = new Set();
  private progressCallbacks: Set<ProgressCallback> = new Set();
  private errorCallbacks: Set<ErrorCallback> = new Set();
  
  public dataBuffer: DataBuffer;

  constructor(serverUrl: string, clientId?: string) {
    this.url = serverUrl;
    this.clientId = clientId || this.generateClientId();
    this.dataBuffer = new DataBuffer();
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const wsUrl = `${this.url}/ws/${this.clientId}`;
        this.ws = new WebSocket(wsUrl);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          console.log(`[WebSocket] Connected to ${wsUrl}`);
          this.reconnectAttempts = 0;
          resolve();
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.ws.onerror = (error) => {
          console.error('[WebSocket] Error:', error);
          this.errorCallbacks.forEach(cb => cb('WebSocket connection error'));
          reject(error);
        };

        this.ws.onclose = () => {
          console.log('[WebSocket] Connection closed');
          this.handleReconnect();
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  send(message: WebSocketMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(this.serializeMessage(message));
    } else {
      console.warn('[WebSocket] Cannot send message: not connected');
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

  private handleMessage(data: ArrayBuffer | string): void {
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
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
      console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
      
      setTimeout(() => {
        this.connect().catch(() => {});
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
}
