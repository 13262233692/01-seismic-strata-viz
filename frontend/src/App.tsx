import React, { useState, useEffect, useRef, useCallback } from 'react';
import { VolumeRenderer } from './engine/VolumeRenderer';
import { WebSocketClient } from './data/DataBuffer';
import { VolumeRenderSettings, DatasetMetadata, SEGYHeader, DataBlock, ProgressUpdate } from './types';
import { ColormapPreset } from './engine/ColormapManager';
import { resourceManager } from './utils/ResourceManager';

resourceManager.enableDebug(true);

const App: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<VolumeRenderer | null>(null);
  const wsClientRef = useRef<WebSocketClient | null>(null);
  const isSwitchingRef = useRef(false);
  
  const [isConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [, setDatasetId] = useState<string | null>(null);
  const [, setMetadata] = useState<DatasetMetadata | null>(null);
  const [header, setHeader] = useState<SEGYHeader | null>(null);
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  const [settings, setSettings] = useState<VolumeRenderSettings>({
    colormap: [],
    sampleRate: 1.0,
    opacity: 0.5,
    brightness: 0.0,
    contrast: 1.0,
    threshold: 0.0,
  });
  
  const [selectedColormap, setSelectedColormap] = useState<ColormapPreset>('seismic');
  const [showControls, setShowControls] = useState(true);
  const [uploadedFiles, setUploadedFiles] = useState<{id: string; name: string; size: number}[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [memoryUsage, setMemoryUsage] = useState({ gpu: 0, cpu: 0, resources: 0 });
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cleanupCallbacksRef = useRef<Array<() => void | Promise<void>>>([]);

  useEffect(() => {
    if (containerRef.current && !rendererRef.current) {
      rendererRef.current = new VolumeRenderer({
        container: containerRef.current,
      });
      
      const colormapManager = rendererRef.current.getColormapManager();
      setSettings(prev => ({
        ...prev,
        colormap: colormapManager.getDefaultColormap(),
      }));
    }
    
    const cleanup = async () => {
      console.log('[App] Running cleanup...');
      
      for (const cb of cleanupCallbacksRef.current) {
        try {
          await cb();
        } catch (e) {
          console.error('[App] Cleanup callback error:', e);
        }
      }
      cleanupCallbacksRef.current = [];
      
      if (wsClientRef.current) {
        await wsClientRef.current.dispose();
        wsClientRef.current = null;
      }
      
      if (rendererRef.current) {
        await rendererRef.current.dispose();
        rendererRef.current = null;
      }
      
      await resourceManager.disposeAll(true);
    };
    
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      cleanup();
      e.preventDefault();
    };
    
    window.addEventListener('beforeunload', handleBeforeUnload);
    
    const interval = setInterval(() => {
      if (rendererRef.current) {
        const gpuMem = rendererRef.current.getMemoryUsage();
        const cpuMem = wsClientRef.current?.getMemoryUsage() || 0;
        const stats = resourceManager.getStats();
        
        setMemoryUsage({
          gpu: gpuMem,
          cpu: cpuMem,
          resources: stats.resourceCount,
        });
      }
    }, 2000);
    
    return () => {
      clearInterval(interval);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      cleanup();
    };
  }, []);

  useEffect(() => {
    initializeWebSocket();
    fetchDatasets();
    
    return () => {
      if (wsClientRef.current) {
        wsClientRef.current.dispose();
        wsClientRef.current = null;
      }
    };
  }, []);

  const initializeWebSocket = useCallback(async () => {
    if (wsClientRef.current) {
      await wsClientRef.current.dispose();
      wsClientRef.current = null;
    }
    
    const wsUrl = 'ws://localhost:8001';
    wsClientRef.current = new WebSocketClient(wsUrl);
    
    const client = wsClientRef.current;
    
    const unsubHeader = client.onHeader((hdr) => {
      setHeader(hdr);
      if (rendererRef.current) {
        rendererRef.current.setHeader(hdr);
      }
    });
    
    const unsubMetadata = client.onMetadata((meta) => {
      setMetadata(meta);
      setIsLoading(false);
      setIsSwitching(false);
      
      if (rendererRef.current && meta.blocks.length > 0) {
        const octree = rendererRef.current.getOctreeScheduler();
        octree.buildFromBlocks(meta.blocks, meta.header);
      }
    });
    
    const unsubBlock = client.onBlock((block: DataBlock) => {
      if (rendererRef.current && !isSwitchingRef.current) {
        rendererRef.current.addBlock(block);
        const octree = rendererRef.current.getOctreeScheduler();
        octree.markBlockLoaded(block.block_id);
      }
    });
    
    const unsubProgress = client.onProgress((prog) => {
      setProgress(prog);
    });
    
    const unsubError = client.onError((err) => {
      setError(err);
      setIsLoading(false);
      setIsSwitching(false);
    });
    
    cleanupCallbacksRef.current.push(
      () => unsubHeader(),
      () => unsubMetadata(),
      () => unsubBlock(),
      () => unsubProgress(),
      () => unsubError(),
    );
  }, []);

  const fetchDatasets = async () => {
    try {
      const response = await fetch('http://localhost:8001/datasets');
      const data = await response.json();
      setUploadedFiles(data.datasets);
    } catch (err) {
      console.error('Failed to fetch datasets:', err);
    }
  };

  const switchDataset = useCallback(async (newDatasetId: string) => {
    if (isSwitchingRef.current) {
      console.log('[App] Already switching dataset, skipping...');
      return;
    }
    
    isSwitchingRef.current = true;
    setIsSwitching(true);
    setError(null);
    setProgress(null);
    
    try {
      console.log('[App] Starting dataset switch...');
      
      if (wsClientRef.current) {
        await wsClientRef.current.dispose();
        wsClientRef.current = null;
      }
      
      if (rendererRef.current) {
        await rendererRef.current.clearVolumeData();
      }
      
      setHeader(null);
      setDatasetId(null);
      setSelectedFile(null);
      
      await new Promise(resolve => setTimeout(resolve, 100));
      await resourceManager.forceGC();
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const stats = resourceManager.getStats();
      console.log(`[App] After cleanup: ${stats.resourceCount} resources, ${stats.currentUsage} bytes`);
      
      await initializeWebSocket();
      
      setDatasetId(newDatasetId);
      setSelectedFile(newDatasetId);
      setIsLoading(true);
      
      const client = wsClientRef.current as WebSocketClient | null;
      if (client) {
        await client.connect();
        client.requestMetadata(newDatasetId);
      }
      
    } catch (err) {
      console.error('[App] Dataset switch failed:', err);
      setError('Failed to switch dataset');
      setIsLoading(false);
      setIsSwitching(false);
      isSwitchingRef.current = false;
    }
  }, [initializeWebSocket]);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    if (isSwitchingRef.current) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      const formData = new FormData();
      formData.append('file', file);
      
      const response = await fetch('http://localhost:8001/upload', {
        method: 'POST',
        body: formData,
      });
      
      const result = await response.json();
      
      await fetchDatasets();
      await switchDataset(result.dataset_id);
      
    } catch (err) {
      setError('Failed to upload file');
      setIsLoading(false);
    }
    
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const loadDataset = useCallback(async (id: string) => {
    await switchDataset(id);
  }, [switchDataset]);

  const handleSettingChange = useCallback((key: keyof VolumeRenderSettings, value: any) => {
    setSettings(prev => {
      const newSettings = { ...prev, [key]: value };
      
      if (rendererRef.current) {
        if (key === 'colormap') {
          rendererRef.current.updateSettings({ colormap: value });
        } else {
          rendererRef.current.updateSettings({ [key]: value });
        }
      }
      
      return newSettings;
    });
  }, []);

  const handleColormapChange = (preset: ColormapPreset) => {
    setSelectedColormap(preset);
    if (rendererRef.current) {
      const colormapManager = rendererRef.current.getColormapManager();
      const colormap = colormapManager.getPreset(preset);
      handleSettingChange('colormap', colormap);
    }
  };

  const handleResetCamera = () => {
    if (rendererRef.current) {
      rendererRef.current.resetCamera();
    }
  };

  const handleLoadDemoData = async () => {
    if (!rendererRef.current || isSwitchingRef.current) return;
    
    isSwitchingRef.current = true;
    setIsSwitching(true);
    setIsLoading(true);
    setError(null);
    
    try {
      if (wsClientRef.current) {
        await wsClientRef.current.dispose();
        wsClientRef.current = null;
      }
      
      await rendererRef.current.clearVolumeData();
      
      await new Promise(resolve => setTimeout(resolve, 100));
      await resourceManager.forceGC();
      
      const width = 64;
      const height = 64;
      const depth = 64;
      const data = new Float32Array(width * height * depth);
      
      for (let z = 0; z < depth; z++) {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const idx = z * width * height + y * width + x;
            
            const nx = x / width - 0.5;
            const ny = y / height - 0.5;
            const nz = z / depth - 0.5;
            
            const dist = Math.sqrt(nx * nx + ny * ny + nz * nz);
            const layers = Math.sin(z * 0.3) * 0.3 + 0.5;
            const noise = (Math.random() - 0.5) * 0.1;
            
            let value = 0.0;
            if (dist < 0.4) {
              value = layers * (1 - dist / 0.4) + noise;
            }
            
            const horizon1 = Math.exp(-Math.pow((y / height - 0.3 + Math.sin(x * 0.1) * 0.1), 2) / 0.01) * 0.5;
            const horizon2 = Math.exp(-Math.pow((y / height - 0.6 + Math.cos(x * 0.08) * 0.08), 2) / 0.008) * 0.4;
            
            value += horizon1 + horizon2;
            
            data[idx] = Math.max(-1, Math.min(1, value));
          }
        }
      }
      
      const demoHeader: SEGYHeader = {
        job_id: 0,
        line_number: 0,
        reel_number: 0,
        num_traces: width * height,
        num_aux_traces: 0,
        sample_interval: 1000,
        sample_interval_original: 1000,
        num_samples: depth,
        num_samples_original: depth,
        data_sample_format: 5,
        ensemble_fold: 1,
        trace_sorting: 0,
        measurement_system: 1,
        coordinate_units: 1,
        num_priority: 0,
        min_x: 0,
        max_x: width,
        min_y: 0,
        max_y: height,
        min_z: 0,
        max_z: depth,
        inline_min: 0,
        inline_max: width - 1,
        xline_min: 0,
        xline_max: height - 1,
        inline_step: 1,
        xline_step: 1,
      };
      
      rendererRef.current.setVolumeData(data, width, height, depth, demoHeader);
      setHeader(demoHeader);
      
    } finally {
      setIsLoading(false);
      setIsSwitching(false);
      isSwitchingRef.current = false;
    }
  };

  const colormapPresets: ColormapPreset[] = [
    'seismic', 'gray', 'viridis', 'plasma', 'inferno',
    'magma', 'cividis', 'coolwarm', 'ocean', 'terrain', 'jet', 'rainbow'
  ];

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '12px 20px',
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        borderBottom: '1px solid rgba(255,255,255,0.1)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 600, color: '#fff' }}>
            🌊 Seismic Strata Visualization
          </h1>
          <span style={{
            padding: '4px 10px',
            borderRadius: '12px',
            fontSize: '12px',
            background: isConnected ? 'rgba(76, 175, 80, 0.2)' : 'rgba(244, 67, 54, 0.2)',
            color: isConnected ? '#4caf50' : '#f44336',
          }}>
            {isConnected ? '● Connected' : '○ Disconnected'}
          </span>
          
          {isSwitching && (
            <span style={{
              padding: '4px 10px',
              borderRadius: '12px',
              fontSize: '12px',
              background: 'rgba(255, 193, 7, 0.2)',
              color: '#ffc107',
            }}>
              ⏳ Switching Dataset...
            </span>
          )}
          
          <div style={{ display: 'flex', gap: '12px', fontSize: '11px', color: '#888' }}>
            <span>GPU: {formatBytes(memoryUsage.gpu)}</span>
            <span>CPU: {formatBytes(memoryUsage.cpu)}</span>
            <span>Resources: {memoryUsage.resources}</span>
          </div>
        </div>
        
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <button
            onClick={() => setShowControls(!showControls)}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: '1px solid rgba(255,255,255,0.2)',
              background: 'rgba(255,255,255,0.1)',
              color: '#fff',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            {showControls ? 'Hide Controls' : 'Show Controls'}
          </button>
          
          <button
            onClick={handleResetCamera}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: '1px solid rgba(255,255,255,0.2)',
              background: 'rgba(255,255,255,0.1)',
              color: '#fff',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            Reset Camera
          </button>
        </div>
      </div>
      
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {showControls && (
          <div style={{
            width: '300px',
            background: 'rgba(20, 20, 35, 0.95)',
            borderRight: '1px solid rgba(255,255,255,0.1)',
            padding: '16px',
            overflowY: 'auto',
          }}>
            <div style={{ marginBottom: '24px' }}>
              <h3 style={{ margin: '0 0 12px 0', fontSize: '14px', color: '#aaa', fontWeight: 600 }}>
                DATA SOURCE
              </h3>
              
              <input
                ref={fileInputRef}
                type="file"
                accept=".sgy,.segy"
                onChange={handleFileUpload}
                style={{ display: 'none' }}
                disabled={isSwitching}
              />
              
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isSwitching || isLoading}
                style={{
                  width: '100%',
                  padding: '10px',
                  borderRadius: '6px',
                  border: 'none',
                  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  color: '#fff',
                  cursor: (isSwitching || isLoading) ? 'not-allowed' : 'pointer',
                  fontSize: '13px',
                  fontWeight: 500,
                  marginBottom: '10px',
                  opacity: (isSwitching || isLoading) ? 0.5 : 1,
                }}
              >
                📁 Upload SEG-Y File
              </button>
              
              <button
                onClick={handleLoadDemoData}
                disabled={isLoading || isSwitching}
                style={{
                  width: '100%',
                  padding: '10px',
                  borderRadius: '6px',
                  border: '1px solid rgba(255,255,255,0.2)',
                  background: 'rgba(255,255,255,0.05)',
                  color: '#fff',
                  cursor: (isLoading || isSwitching) ? 'not-allowed' : 'pointer',
                  fontSize: '13px',
                  opacity: (isLoading || isSwitching) ? 0.5 : 1,
                }}
              >
                {isLoading ? 'Loading...' : '🎯 Load Demo Data'}
              </button>
              
              {uploadedFiles.length > 0 && (
                <div style={{ marginTop: '12px' }}>
                  <div style={{ fontSize: '12px', color: '#888', marginBottom: '6px' }}>
                    Available Datasets:
                  </div>
                  {uploadedFiles.map(file => (
                    <button
                      key={file.id}
                      onClick={() => loadDataset(file.id)}
                      disabled={isSwitching}
                      style={{
                        width: '100%',
                        padding: '8px',
                        marginBottom: '4px',
                        borderRadius: '4px',
                        border: selectedFile === file.id ? '1px solid #667eea' : '1px solid rgba(255,255,255,0.1)',
                        background: selectedFile === file.id ? 'rgba(102, 126, 234, 0.2)' : 'rgba(255,255,255,0.05)',
                        color: '#fff',
                        cursor: isSwitching ? 'not-allowed' : 'pointer',
                        fontSize: '12px',
                        textAlign: 'left',
                        opacity: isSwitching ? 0.5 : 1,
                      }}
                    >
                      {file.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            
            {progress && (
              <div style={{ marginBottom: '24px' }}>
                <h3 style={{ margin: '0 0 8px 0', fontSize: '14px', color: '#aaa', fontWeight: 600 }}>
                  PROGRESS
                </h3>
                <div style={{
                  background: 'rgba(255,255,255,0.1)',
                  borderRadius: '4px',
                  height: '8px',
                  overflow: 'hidden',
                  marginBottom: '6px',
                }}>
                  <div style={{
                    width: `${progress.percent_complete}%`,
                    height: '100%',
                    background: 'linear-gradient(90deg, #667eea, #764ba2)',
                    transition: 'width 0.3s ease',
                  }} />
                </div>
                <div style={{ fontSize: '11px', color: '#888' }}>
                  {progress.message || `${progress.percent_complete.toFixed(1)}%`}
                </div>
              </div>
            )}
            
            <div style={{ marginBottom: '24px' }}>
              <h3 style={{ margin: '0 0 12px 0', fontSize: '14px', color: '#aaa', fontWeight: 600 }}>
                COLORMAP
              </h3>
              <select
                value={selectedColormap}
                onChange={(e) => handleColormapChange(e.target.value as ColormapPreset)}
                style={{
                  width: '100%',
                  padding: '8px',
                  borderRadius: '4px',
                  border: '1px solid rgba(255,255,255,0.2)',
                  background: 'rgba(255,255,255,0.1)',
                  color: '#fff',
                  fontSize: '13px',
                }}
              >
                {colormapPresets.map(preset => (
                  <option key={preset} value={preset} style={{ background: '#1a1a2e' }}>
                    {preset.charAt(0).toUpperCase() + preset.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            
            <div style={{ marginBottom: '24px' }}>
              <h3 style={{ margin: '0 0 12px 0', fontSize: '14px', color: '#aaa', fontWeight: 600 }}>
                RENDERING
              </h3>
              
              {[
                { key: 'sampleRate', label: 'Sample Rate', min: 0.5, max: 2.0, step: 0.1 },
                { key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.05 },
                { key: 'brightness', label: 'Brightness', min: -0.5, max: 0.5, step: 0.05 },
                { key: 'contrast', label: 'Contrast', min: 0.5, max: 2.0, step: 0.1 },
                { key: 'threshold', label: 'Threshold', min: 0, max: 1, step: 0.05 },
              ].map(({ key, label, min, max, step }) => (
                <div key={key} style={{ marginBottom: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <span style={{ fontSize: '12px', color: '#ccc' }}>{label}</span>
                    <span style={{ fontSize: '12px', color: '#888' }}>
                      {(settings[key as keyof VolumeRenderSettings] as number).toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={settings[key as keyof VolumeRenderSettings] as number}
                    onChange={(e) => handleSettingChange(key as keyof VolumeRenderSettings, parseFloat(e.target.value))}
                    style={{ width: '100%', accentColor: '#667eea' }}
                  />
                </div>
              ))}
            </div>
            
            {header && (
              <div style={{ marginBottom: '24px' }}>
                <h3 style={{ margin: '0 0 12px 0', fontSize: '14px', color: '#aaa', fontWeight: 600 }}>
                  DATASET INFO
                </h3>
                <div style={{ fontSize: '12px', color: '#ccc', lineHeight: 1.8 }}>
                  <div><strong style={{ color: '#888' }}>Samples:</strong> {header.num_samples}</div>
                  <div><strong style={{ color: '#888' }}>Inlines:</strong> {header.inline_max - header.inline_min + 1}</div>
                  <div><strong style={{ color: '#888' }}>Xlines:</strong> {header.xline_max - header.xline_min + 1}</div>
                  <div><strong style={{ color: '#888' }}>X Range:</strong> [{header.min_x.toFixed(0)}, {header.max_x.toFixed(0)}]</div>
                  <div><strong style={{ color: '#888' }}>Y Range:</strong> [{header.min_y.toFixed(0)}, {header.max_y.toFixed(0)}]</div>
                  <div><strong style={{ color: '#888' }}>Z Range:</strong> [{header.min_z.toFixed(0)}, {header.max_z.toFixed(0)}]</div>
                </div>
              </div>
            )}
            
            {error && (
              <div style={{
                padding: '10px',
                borderRadius: '6px',
                background: 'rgba(244, 67, 54, 0.2)',
                border: '1px solid rgba(244, 67, 54, 0.3)',
                color: '#f44336',
                fontSize: '12px',
              }}>
                ⚠️ {error}
              </div>
            )}
          </div>
        )}
        
        <div ref={containerRef} style={{ flex: 1, position: 'relative' }} />
      </div>
      
      <div style={{
        padding: '8px 20px',
        background: 'rgba(15, 15, 25, 0.95)',
        borderTop: '1px solid rgba(255,255,255,0.1)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontSize: '11px',
        color: '#666',
      }}>
        <div>
          <span style={{ marginRight: '16px' }}>🖱️ Left Drag: Rotate</span>
          <span style={{ marginRight: '16px' }}>🖱️ Right Drag: Pan</span>
          <span>🖱️ Scroll: Zoom</span>
        </div>
        <div>
          Seismic Strata Visualization Engine v1.0 | Memory-Safe Mode
        </div>
      </div>
    </div>
  );
};

export default App;
