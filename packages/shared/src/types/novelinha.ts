export type NovelinhaPosition = 'left' | 'center' | 'right';

export type CameraMotion =
  | 'zoom_in'
  | 'zoom_out'
  | 'pan_left'
  | 'pan_right'
  | 'pan_up'
  | 'pan_down'
  | 'none';

export type FramingMode = 'fill' | 'blur_background' | 'fit';

export interface NovelinhaScene {
  imagePath?: string;
  mediaPath?: string;
  audioPath: string;
  captionText?: string;
  caption?: string;
  position?: NovelinhaPosition;
  cameraMotion?: CameraMotion | string;
  framing?: FramingMode | string;
}

export interface NovelinhaAssembleRequest {
  title?: string;
  backgroundColor?: string;
  framing?: FramingMode | string;
  scenes: NovelinhaScene[];
  wait?: boolean;
}

export interface NovelinhaAssembleResponse {
  success: boolean;
  jobId?: string;
  projectId?: string;
  duration?: number;
  outputPath?: string;
  error?: string;
}
