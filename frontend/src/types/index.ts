export interface SEGYHeader {
  job_id: number;
  line_number: number;
  reel_number: number;
  num_traces: number;
  num_aux_traces: number;
  sample_interval: number;
  sample_interval_original: number;
  num_samples: number;
  num_samples_original: number;
  data_sample_format: number;
  ensemble_fold: number;
  trace_sorting: number;
  measurement_system: number;
  coordinate_units: number;
  num_priority: number;
  min_x: number;
  max_x: number;
  min_y: number;
  max_y: number;
  min_z: number;
  max_z: number;
  inline_min: number;
  inline_max: number;
  xline_min: number;
  xline_max: number;
  inline_step: number;
  xline_step: number;
}

export interface BoundingBox {
  min_x: number;
  max_x: number;
  min_y: number;
  max_y: number;
  min_z: number;
  max_z: number;
}

export interface DataBlock {
  block_id: string;
  level: number;
  inline_start: number;
  inline_end: number;
  xline_start: number;
  xline_end: number;
  depth_start: number;
  depth_end: number;
  num_inline: number;
  num_xline: number;
  num_depth: number;
  amplitude_data: Uint8Array;
  min_amplitude: number;
  max_amplitude: number;
  bounding_box: BoundingBox;
}

export interface BlockInfo {
  block_id: string;
  level: number;
  bounding_box: BoundingBox;
  data_size: number;
}

export interface DatasetMetadata {
  dataset_id: string;
  name: string;
  file_size: number;
  header: SEGYHeader;
  blocks: BlockInfo[];
}

export interface ProgressUpdate {
  percent_complete: number;
  message: string;
  bytes_processed: number;
  total_bytes: number;
}

export interface ErrorMessage {
  code: number;
  message: string;
  details: string;
}

export interface BlockRequest {
  block_ids: string[];
  level: number;
  stream: boolean;
}

export interface ViewFrustum {
  matrix: number[];
  fov: number;
  aspect: number;
  near: number;
  far: number;
}

export enum MessageType {
  HEADER = 0,
  DATA_BLOCK = 1,
  METADATA = 2,
  PROGRESS = 3,
  ERROR = 4,
  COMPLETE = 5,
  REQUEST_BLOCK = 6,
  VIEW_FRUSTUM = 7,
}

export interface WebSocketMessage {
  type: MessageType;
  request_id: string;
  header?: SEGYHeader;
  data_block?: DataBlock;
  metadata?: DatasetMetadata;
  progress?: ProgressUpdate;
  error?: ErrorMessage;
  block_request?: BlockRequest;
  view_frustum?: ViewFrustum;
}

export interface OctreeNodeData {
  node_id: string;
  level: number;
  bounds: {
    inline: [number, number];
    xline: [number, number];
    depth: [number, number];
  };
  children: OctreeNodeData[];
  block?: BlockInfo;
}

export interface ColormapStop {
  value: number;
  color: [number, number, number];
}

export interface VolumeRenderSettings {
  colormap: ColormapStop[];
  sampleRate: number;
  opacity: number;
  brightness: number;
  contrast: number;
  threshold: number;
}
