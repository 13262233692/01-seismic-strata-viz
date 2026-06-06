import { ColormapStop } from '../types';

export type ColormapPreset = 
  | 'seismic'
  | 'gray'
  | 'rainbow'
  | 'viridis'
  | 'plasma'
  | 'inferno'
  | 'magma'
  | 'cividis'
  | 'coolwarm'
  | 'ocean'
  | 'terrain'
  | 'jet';

export class ColormapManager {
  private presets: Map<ColormapPreset, ColormapStop[]> = new Map();
  
  constructor() {
    this.initPresets();
  }
  
  private initPresets(): void {
    this.presets.set('seismic', [
      { value: 0.0, color: [0.0, 0.0, 1.0] },
      { value: 0.25, color: [0.0, 0.5, 1.0] },
      { value: 0.5, color: [1.0, 1.0, 1.0] },
      { value: 0.75, color: [1.0, 0.5, 0.0] },
      { value: 1.0, color: [1.0, 0.0, 0.0] },
    ]);
    
    this.presets.set('gray', [
      { value: 0.0, color: [0.0, 0.0, 0.0] },
      { value: 1.0, color: [1.0, 1.0, 1.0] },
    ]);
    
    this.presets.set('rainbow', [
      { value: 0.0, color: [1.0, 0.0, 0.0] },
      { value: 0.2, color: [1.0, 1.0, 0.0] },
      { value: 0.4, color: [0.0, 1.0, 0.0] },
      { value: 0.6, color: [0.0, 1.0, 1.0] },
      { value: 0.8, color: [0.0, 0.0, 1.0] },
      { value: 1.0, color: [1.0, 0.0, 1.0] },
    ]);
    
    this.presets.set('viridis', [
      { value: 0.0, color: [0.267, 0.004, 0.329] },
      { value: 0.25, color: [0.282, 0.140, 0.458] },
      { value: 0.5, color: [0.190, 0.407, 0.556] },
      { value: 0.75, color: [0.208, 0.718, 0.563] },
      { value: 1.0, color: [0.993, 0.906, 0.144] },
    ]);
    
    this.presets.set('plasma', [
      { value: 0.0, color: [0.050, 0.029, 0.527] },
      { value: 0.25, color: [0.454, 0.025, 0.638] },
      { value: 0.5, color: [0.771, 0.255, 0.574] },
      { value: 0.75, color: [0.975, 0.573, 0.411] },
      { value: 1.0, color: [0.940, 0.975, 0.626] },
    ]);
    
    this.presets.set('inferno', [
      { value: 0.0, color: [0.001, 0.000, 0.003] },
      { value: 0.25, color: [0.257, 0.036, 0.507] },
      { value: 0.5, color: [0.661, 0.164, 0.476] },
      { value: 0.75, color: [0.972, 0.509, 0.296] },
      { value: 1.0, color: [0.988, 0.998, 0.645] },
    ]);
    
    this.presets.set('magma', [
      { value: 0.0, color: [0.001, 0.000, 0.003] },
      { value: 0.25, color: [0.276, 0.042, 0.423] },
      { value: 0.5, color: [0.635, 0.170, 0.524] },
      { value: 0.75, color: [0.958, 0.456, 0.394] },
      { value: 1.0, color: [0.987, 0.962, 0.612] },
    ]);
    
    this.presets.set('cividis', [
      { value: 0.0, color: [0.000, 0.125, 0.302] },
      { value: 0.25, color: [0.240, 0.373, 0.443] },
      { value: 0.5, color: [0.539, 0.592, 0.401] },
      { value: 0.75, color: [0.833, 0.790, 0.347] },
      { value: 1.0, color: [1.000, 0.996, 0.937] },
    ]);
    
    this.presets.set('coolwarm', [
      { value: 0.0, color: [0.229, 0.299, 0.754] },
      { value: 0.5, color: [0.865, 0.865, 0.865] },
      { value: 1.0, color: [0.706, 0.016, 0.150] },
    ]);
    
    this.presets.set('ocean', [
      { value: 0.0, color: [0.0, 0.0, 0.3] },
      { value: 0.33, color: [0.0, 0.2, 0.5] },
      { value: 0.66, color: [0.0, 0.5, 0.7] },
      { value: 1.0, color: [0.8, 0.9, 1.0] },
    ]);
    
    this.presets.set('terrain', [
      { value: 0.0, color: [0.2, 0.3, 0.1] },
      { value: 0.25, color: [0.4, 0.5, 0.2] },
      { value: 0.5, color: [0.6, 0.55, 0.35] },
      { value: 0.75, color: [0.7, 0.6, 0.5] },
      { value: 1.0, color: [0.95, 0.95, 0.95] },
    ]);
    
    this.presets.set('jet', [
      { value: 0.0, color: [0.0, 0.0, 0.5] },
      { value: 0.16, color: [0.0, 0.0, 1.0] },
      { value: 0.33, color: [0.0, 0.5, 1.0] },
      { value: 0.5, color: [0.0, 1.0, 1.0] },
      { value: 0.66, color: [0.5, 1.0, 0.5] },
      { value: 0.83, color: [1.0, 1.0, 0.0] },
      { value: 1.0, color: [1.0, 0.0, 0.0] },
    ]);
  }
  
  getPresetNames(): ColormapPreset[] {
    return Array.from(this.presets.keys());
  }
  
  getPreset(name: ColormapPreset): ColormapStop[] {
    return this.presets.get(name) || this.getDefaultColormap();
  }
  
  getDefaultColormap(): ColormapStop[] {
    return this.getPreset('seismic');
  }
  
  createColormapTexture(stops: ColormapStop[], size: number = 256): Uint8Array {
    const data = new Uint8Array(size * 4);
    
    for (let i = 0; i < size; i++) {
      const t = i / (size - 1);
      const color = this.interpolateColor(stops, t);
      
      data[i * 4] = Math.floor(color[0] * 255);
      data[i * 4 + 1] = Math.floor(color[1] * 255);
      data[i * 4 + 2] = Math.floor(color[2] * 255);
      data[i * 4 + 3] = 255;
    }
    
    return data;
  }
  
  interpolateColor(stops: ColormapStop[], t: number): [number, number, number] {
    t = Math.max(0, Math.min(1, t));
    
    let lower = stops[0];
    let upper = stops[stops.length - 1];
    
    for (let i = 0; i < stops.length - 1; i++) {
      if (t >= stops[i].value && t <= stops[i + 1].value) {
        lower = stops[i];
        upper = stops[i + 1];
        break;
      }
    }
    
    const range = upper.value - lower.value;
    const localT = range > 0 ? (t - lower.value) / range : 0;
    
    return [
      lower.color[0] + (upper.color[0] - lower.color[0]) * localT,
      lower.color[1] + (upper.color[1] - lower.color[1]) * localT,
      lower.color[2] + (upper.color[2] - lower.color[2]) * localT,
    ];
  }
  
  createCustomColormap(colors: [number, number, number][]): ColormapStop[] {
    return colors.map((color, index) => ({
      value: index / (colors.length - 1),
      color,
    }));
  }
  
  reverseColormap(stops: ColormapStop[]): ColormapStop[] {
    return stops
      .map(stop => ({
        value: 1 - stop.value,
        color: [...stop.color] as [number, number, number],
      }))
      .sort((a, b) => a.value - b.value);
  }
  
  adjustBrightness(stops: ColormapStop[], brightness: number): ColormapStop[] {
    return stops.map(stop => ({
      value: stop.value,
      color: [
        Math.max(0, Math.min(1, stop.color[0] + brightness)),
        Math.max(0, Math.min(1, stop.color[1] + brightness)),
        Math.max(0, Math.min(1, stop.color[2] + brightness)),
      ],
    }));
  }
  
  adjustContrast(stops: ColormapStop[], contrast: number): ColormapStop[] {
    return stops.map(stop => ({
      value: stop.value,
      color: [
        Math.max(0, Math.min(1, (stop.color[0] - 0.5) * contrast + 0.5)),
        Math.max(0, Math.min(1, (stop.color[1] - 0.5) * contrast + 0.5)),
        Math.max(0, Math.min(1, (stop.color[2] - 0.5) * contrast + 0.5)),
      ],
    }));
  }
  
  colorToHex(color: [number, number, number]): string {
    const r = Math.floor(color[0] * 255);
    const g = Math.floor(color[1] * 255);
    const b = Math.floor(color[2] * 255);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }
  
  hexToColor(hex: string): [number, number, number] {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? [
          parseInt(result[1], 16) / 255,
          parseInt(result[2], 16) / 255,
          parseInt(result[3], 16) / 255,
        ]
      : [0, 0, 0];
  }
}
