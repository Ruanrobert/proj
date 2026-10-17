import { spawn } from 'bun';
import { join, resolve, relative, extname } from 'path';
import { nanoid } from 'nanoid';
import type {
  Project,
  VideoSource,
  AudioSource,
  OverlaySource,
  VideoSegment,
  OverlaySegment,
  AudioSegment,
  CaptionSegment,
  ExportProgress,
  NovelinhaAssembleRequest,
  NovelinhaAssembleResponse,
  NovelinhaPosition,
  CameraMotion,
  FramingMode,
  OverlayPosition,
} from '@proj/shared';
import { DEFAULT_CAPTION_STYLE } from '@proj/shared';
import { FFMPEG_PATH, FFPROBE_PATH } from '@proj/ffmpeg';
import { saveProject } from './projects';
import { startExport, getExportJob, type ExportJob } from './ffmpeg';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const DATA_DIR = resolve(join(import.meta.dir, '../../../../data'));
const UPLOADS_DIR = join(DATA_DIR, 'uploads');
const TEMP_DIR = join(DATA_DIR, 'temp');

export const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
export const ALLOWED_VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv']);
export const ALLOWED_MEDIA_EXTS = new Set([...ALLOWED_IMAGE_EXTS, ...ALLOWED_VIDEO_EXTS]);
export const ALLOWED_AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);

export const NOVELINHA_CAPTION_STYLE = {
  ...DEFAULT_CAPTION_STYLE,
  fontSize: 48,
  padding: 20,
  backgroundColor: '#000000',
  backgroundOpacity: 0.65,
  position: {
    vertical: 'bottom' as const,
    horizontal: 'center' as const,
    offsetX: 0,
    offsetY: 180, // Safe lower area for TikTok, Reels, Shorts UI
  },
};

const HEX_COLOR_REGEX = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const NAMED_COLORS = new Set([
  'black', 'white', 'red', 'green', 'blue', 'yellow', 'cyan', 'magenta',
  'gray', 'grey', 'darkblue', 'navy', 'purple', 'orange', 'pink'
]);

export function sanitizeColor(color?: string): string {
  if (!color || color.trim() === '') {
    return '0x1E1E2E'; // Default dark purple/blue theme
  }
  const trimmed = color.trim();
  if (HEX_COLOR_REGEX.test(trimmed)) {
    const raw = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
    const hex = raw.length === 3
      ? raw.split('').map(c => c + c).join('')
      : raw;
    return `0x${hex}`;
  }
  const lower = trimmed.toLowerCase();
  if (NAMED_COLORS.has(lower)) {
    return lower;
  }
  throw new ValidationError(
    `Invalid background color '${color}'. Provide a valid hex code (e.g. #FFFFFF or #1E1E2E) or a standard color name.`
  );
}

export async function validateAndResolvePath(
  inputPath: string,
  allowedExts: Set<string>,
  kind: 'image' | 'audio' | 'video'
): Promise<string> {
  if (!inputPath || typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new ValidationError(`Missing ${kind} path`);
  }

  const cleanInput = inputPath.trim();
  let resolved: string;

  if (cleanInput.startsWith('/uploads/') || cleanInput.startsWith('/thumbnails/') || cleanInput.startsWith('/exports/')) {
    resolved = resolve(DATA_DIR, cleanInput.slice(1));
  } else if (cleanInput.startsWith('uploads/') || cleanInput.startsWith('thumbnails/') || cleanInput.startsWith('exports/')) {
    resolved = resolve(DATA_DIR, cleanInput);
  } else if (resolve(cleanInput) === cleanInput) {
    resolved = resolve(cleanInput);
  } else {
    resolved = resolve(DATA_DIR, cleanInput);
  }

  // Security check: ensure path does not escape DATA_DIR
  const rel = relative(DATA_DIR, resolved);
  if (rel.startsWith('..') || resolve(DATA_DIR, rel) !== resolved) {
    throw new ValidationError(
      `Access denied: path '${inputPath}' is outside the allowed data directories`
    );
  }

  // Extension check
  const ext = extname(resolved).toLowerCase();
  if (!allowedExts.has(ext)) {
    throw new ValidationError(
      `Invalid ${kind} extension '${ext}' for '${inputPath}'. Allowed: ${Array.from(allowedExts).join(', ')}`
    );
  }

  // File existence check
  const file = Bun.file(resolved);
  if (!(await file.exists())) {
    throw new ValidationError(`File not found: '${inputPath}' (resolved to '${resolved}')`);
  }

  return resolved;
}

export async function getAudioDuration(audioPath: string): Promise<number> {
  const proc = spawn({
    cmd: [
      FFPROBE_PATH,
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      audioPath,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const errText = await new Response(proc.stderr).text();
    throw new Error(`ffprobe failed for '${audioPath}': ${errText}`);
  }

  const duration = parseFloat(output.trim());
  if (isNaN(duration) || duration <= 0) {
    throw new ValidationError(`Could not determine valid audio duration for '${audioPath}'`);
  }

  return duration;
}

async function getVideoMetadata(videoPath: string): Promise<{
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  bitrate: number;
}> {
  const proc = spawn({
    cmd: [
      FFPROBE_PATH,
      '-v', 'error',
      '-show_entries', 'format=duration,bit_rate:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate',
      '-of', 'json',
      videoPath,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [output, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const errText = await new Response(proc.stderr).text();
    throw new ValidationError(`Could not read video metadata for '${videoPath}': ${errText.trim()}`);
  }

  try {
    const probe = JSON.parse(output);
    const stream = probe.streams?.find((item: any) => item.codec_type === 'video');
    const duration = Number(probe.format?.duration);
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    const [fpsNumerator, fpsDenominator = 1] = String(stream?.avg_frame_rate || stream?.r_frame_rate || '30/1')
      .split('/')
      .map(Number);
    const fps = fpsDenominator ? Math.round(fpsNumerator / fpsDenominator) : fpsNumerator;

    if (!stream || !Number.isFinite(duration) || duration <= 0 || width <= 0 || height <= 0) {
      throw new Error('missing video stream, duration, or dimensions');
    }

    return {
      duration,
      width,
      height,
      fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
      codec: String(stream.codec_name || 'unknown'),
      bitrate: Number(probe.format?.bit_rate) || 0,
    };
  } catch (error) {
    throw new ValidationError(`Invalid video media '${videoPath}': ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function generateBackgroundVideo(
  color: string,
  duration: number,
  outputPath: string
): Promise<void> {
  const sanitized = sanitizeColor(color);
  const proc = spawn({
    cmd: [
      FFMPEG_PATH,
      '-y',
      '-f', 'lavfi',
      '-i', `color=c=${sanitized}:s=1080x1920:r=30`,
      '-t', `${duration}`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      outputPath,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const errText = await new Response(proc.stderr).text();
    throw new Error(`FFmpeg background generation failed: ${errText}`);
  }
}

export async function generateSceneBlurredBackgroundVideo(
  scenes: Array<{ imagePath: string; duration: number }>,
  outputPath: string
): Promise<void> {
  if (scenes.length === 0) {
    throw new ValidationError('Cannot generate background without scenes');
  }

  // Single scene: direct amplified blurred and slightly darkened 9:16 background
  if (scenes.length === 1) {
    const scene = scenes[0];
    const proc = spawn({
      cmd: [
        FFMPEG_PATH,
        '-y',
        '-loop', '1',
        '-t', `${scene.duration}`,
        '-i', scene.imagePath,
        '-filter_complex',
        '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:5,eq=brightness=-0.15:contrast=0.9,setsar=1,fps=30,format=yuv420p[outv]',
        '-map', '[outv]',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        outputPath,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const errText = await new Response(proc.stderr).text();
      throw new Error(`FFmpeg blurred background generation failed: ${errText}`);
    }
    return;
  }

  // Multiple scenes: build per-scene amplified blurred stream and concatenate
  const inputs: string[] = [];
  const filterParts: string[] = [];
  const concatInputs: string[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    inputs.push('-loop', '1', '-t', `${scene.duration}`, '-i', scene.imagePath);
    filterParts.push(
      `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:5,eq=brightness=-0.15:contrast=0.9,setsar=1,fps=30,format=yuv420p[bg${i}]`
    );
    concatInputs.push(`[bg${i}]`);
  }

  filterParts.push(
    `${concatInputs.join('')}concat=n=${scenes.length}:v=1:a=0[outv]`
  );

  const proc = spawn({
    cmd: [
      FFMPEG_PATH,
      '-y',
      ...inputs,
      '-filter_complex',
      filterParts.join(';'),
      '-map', '[outv]',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      outputPath,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const errText = await new Response(proc.stderr).text();
    throw new Error(`FFmpeg blurred background generation failed: ${errText}`);
  }
}

export function normalizeCameraMotion(motion?: string | CameraMotion): CameraMotion {
  if (!motion || typeof motion !== 'string') return 'none';
  const clean = motion.trim().toLowerCase();
  switch (clean) {
    case 'zoom_in':
    case 'zoomin':
    case 'aproximacao':
    case 'aproximação':
    case 'in':
      return 'zoom_in';
    case 'zoom_out':
    case 'zoomout':
    case 'afastamento':
    case 'out':
      return 'zoom_out';
    case 'pan_left':
    case 'panleft':
    case 'lateral_esquerda':
    case 'esquerda':
    case 'left':
      return 'pan_left';
    case 'pan_right':
    case 'panright':
    case 'lateral_direita':
    case 'lateral':
    case 'direita':
    case 'right':
      return 'pan_right';
    case 'pan_up':
    case 'panup':
    case 'cima':
    case 'up':
      return 'pan_up';
    case 'pan_down':
    case 'pandown':
    case 'baixo':
    case 'down':
      return 'pan_down';
    case 'none':
    case 'estatico':
    case 'estático':
    case 'static':
      return 'none';
    default:
      throw new ValidationError(
        `Invalid camera motion '${motion}'. Allowed: 'zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'pan_up', 'pan_down', or 'none'.`
      );
  }
}

export async function getImageDimensions(imagePath: string): Promise<{ width: number; height: number }> {
  const proc = spawn({
    cmd: [
      FFPROBE_PATH,
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0',
      imagePath,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode === 0) {
    const [w, h] = output.trim().split(',').map(Number);
    if (w && h && !isNaN(w) && !isNaN(h)) {
      return { width: w, height: h };
    }
  }
  return { width: 1080, height: 1080 };
}

export async function convertImageToOverlayVideo(
  imagePath: string,
  duration: number,
  outputPath: string,
  motion: CameraMotion = 'none',
  fps: number = 30
): Promise<void> {
  const totalFrames = Math.max(1, Math.round(duration * fps));
  // WebM/VP9 is supported by the browser preview and stores the alpha plane
  // separately from the color planes. `-auto-alt-ref 0` is required by libvpx
  // when encoding a stream with alpha.
  const alphaVideoArgs = [
    '-c:v', 'libvpx-vp9',
    '-pix_fmt', 'yuva420p',
    '-auto-alt-ref', '0',
    '-b:v', '0',
    '-crf', '30',
    '-an',
  ];

  if (motion === 'none') {
    const proc = spawn({
      cmd: [
        FFMPEG_PATH,
        '-y',
        '-loop', '1',
        '-framerate', `${fps}`,
        '-t', `${duration}`,
        '-i', imagePath,
        '-vf', 'format=rgba',
        ...alphaVideoArgs,
        outputPath,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const errText = await new Response(proc.stderr).text();
      throw new Error(`FFmpeg overlay conversion failed for '${imagePath}': ${errText}`);
    }
    return;
  }

  // Get original image dimensions to preserve sharpness and aspect ratio
  const dims = await getImageDimensions(imagePath);
  const w = dims.width;
  const h = dims.height;

  // Build smooth cinematic camera motion expression
  let filterExpr: string;

  switch (motion) {
    case 'zoom_in':
      // Smooth progressive zoom from 1.0x to 1.18x centered slightly above midpoint (character face)
      filterExpr = `zoompan=z='1.0+0.18*(on/${totalFrames})':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)*0.35':d=${totalFrames}:s=${w}x${h}:fps=${fps}`;
      break;

    case 'zoom_out':
      // Smooth progressive pull-out from 1.18x down to 1.0x
      filterExpr = `zoompan=z='1.18-0.18*(on/${totalFrames})':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)*0.35':d=${totalFrames}:s=${w}x${h}:fps=${fps}`;
      break;

    case 'pan_left':
      // Smooth horizontal truck/pan to the left with subtle 1.12x zoom margin
      filterExpr = `zoompan=z='1.12':x='(iw-iw/zoom)*(1.0-(on/${totalFrames}))':y='(ih-ih/zoom)/2':d=${totalFrames}:s=${w}x${h}:fps=${fps}`;
      break;

    case 'pan_right':
      // Smooth horizontal truck/pan to the right with subtle 1.12x zoom margin
      filterExpr = `zoompan=z='1.12':x='(iw-iw/zoom)*(on/${totalFrames})':y='(ih-ih/zoom)/2':d=${totalFrames}:s=${w}x${h}:fps=${fps}`;
      break;

    case 'pan_up':
      // Smooth vertical pan upwards
      filterExpr = `zoompan=z='1.12':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)*(1.0-(on/${totalFrames}))':d=${totalFrames}:s=${w}x${h}:fps=${fps}`;
      break;

    case 'pan_down':
      // Smooth vertical pan downwards
      filterExpr = `zoompan=z='1.12':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)*(on/${totalFrames})':d=${totalFrames}:s=${w}x${h}:fps=${fps}`;
      break;

    default:
      filterExpr = `zoompan=z='1.0':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=${totalFrames}:s=${w}x${h}:fps=${fps}`;
      break;
  }

  const proc = spawn({
    cmd: [
      FFMPEG_PATH,
      '-y',
      '-loop', '1',
      '-i', imagePath,
      '-vf', `${filterExpr},format=rgba`,
      ...alphaVideoArgs,
      '-t', `${duration}`,
      outputPath,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const errText = await new Response(proc.stderr).text();
    throw new Error(`FFmpeg camera motion conversion failed for '${imagePath}': ${errText}`);
  }
}

export function getOverlayPosition(pos: NovelinhaPosition): OverlayPosition {
  switch (pos) {
    case 'left':
      return { x: 0.05, y: 0.40, width: 0.50, height: 0.35 };
    case 'right':
      return { x: 0.45, y: 0.40, width: 0.50, height: 0.35 };
    case 'center':
    default:
      return { x: 0.25, y: 0.40, width: 0.50, height: 0.35 };
  }
}

export async function waitForExportJob(jobId: string, timeoutMs = 120000): Promise<ExportJob> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = getExportJob(jobId);
    if (job) {
      if (job.status === 'complete') {
        return job;
      }
      if (job.status === 'error') {
        throw new Error(job.error || 'Export failed');
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Export job ${jobId} timed out after ${timeoutMs}ms`);
}

export async function assembleNovelinha(
  request: NovelinhaAssembleRequest,
  onProgress?: (jobId: string, progress: ExportProgress) => void
): Promise<NovelinhaAssembleResponse> {
  if (!request || !request.scenes || !Array.isArray(request.scenes) || request.scenes.length === 0) {
    throw new ValidationError('At least one scene is required to assemble a novelinha');
  }

  // Ensure directories exist
  const { mkdir } = await import('fs/promises');
  await mkdir(UPLOADS_DIR, { recursive: true });
  await mkdir(TEMP_DIR, { recursive: true });

  const projectId = nanoid();
  const projectName = request.title?.trim() || 'Novelinha de Frutas';

  // Step 1: Validate and resolve paths for each scene
  const resolvedScenes: Array<{
    imagePath?: string;
    videoPath?: string;
    videoMetadata?: Awaited<ReturnType<typeof getVideoMetadata>>;
    audioPath: string;
    caption: string;
    position: NovelinhaPosition;
    cameraMotion: CameraMotion;
    duration: number;
    startTime: number;
  }> = [];

  let currentTime = 0;

  for (let i = 0; i < request.scenes.length; i++) {
    const scene = request.scenes[i];
    if (!scene) {
      throw new ValidationError(`Scene at index ${i} is empty`);
    }

    const pos = (scene.position || 'center').toLowerCase() as NovelinhaPosition;
    if (pos !== 'left' && pos !== 'center' && pos !== 'right') {
      throw new ValidationError(
        `Invalid position '${scene.position}' at scene ${i}. Must be 'left', 'center', or 'right'.`
      );
    }

    const cameraMotion = normalizeCameraMotion(scene.cameraMotion);
    let resolvedImage: string | undefined;
    let resolvedVideo: string | undefined;
    let videoMetadata: Awaited<ReturnType<typeof getVideoMetadata>> | undefined;
    if (scene.mediaPath !== undefined) {
      if (request.scenes.length !== 1) {
        throw new ValidationError('A complete video source must be assembled as a single scene');
      }
      resolvedVideo = await validateAndResolvePath(scene.mediaPath, ALLOWED_VIDEO_EXTS, 'video');
      videoMetadata = await getVideoMetadata(resolvedVideo);
    } else {
      resolvedImage = await validateAndResolvePath(scene.imagePath || '', ALLOWED_IMAGE_EXTS, 'image');
    }
    const resolvedAudio = await validateAndResolvePath(scene.audioPath, ALLOWED_AUDIO_EXTS, 'audio');

    // Video-backed scenes follow the source video's duration. Image scenes keep
    // the existing audio-driven timing behavior.
    const duration = videoMetadata?.duration ?? await getAudioDuration(resolvedAudio);

    const caption = (scene.captionText ?? scene.caption ?? '').trim();

    resolvedScenes.push({
      imagePath: resolvedImage,
      videoPath: resolvedVideo,
      videoMetadata,
      audioPath: resolvedAudio,
      caption,
      position: pos,
      cameraMotion,
      duration,
      startTime: currentTime,
    });

    currentTime += duration;
  }

  const totalDuration = currentTime;
  if (totalDuration <= 0) {
    throw new ValidationError('Total duration of novelinha must be greater than 0');
  }

  const completeVideoScene = resolvedScenes.length === 1 && resolvedScenes[0]?.videoPath;

  // Step 2: Generate vertical 9:16 background video (1080x1920 @ 30fps)
  // Fill the 9:16 frame using the scene's own image amplified, blurred and slightly darkened
  // to avoid large empty dark areas while keeping the main layer sharp and proportional
  const bgFilename = `novelinha_bg_${projectId}.mp4`;
  const bgFilePath = join(UPLOADS_DIR, bgFilename);

  const hasCustomSolidColor = request.backgroundColor &&
    request.backgroundColor.trim() !== '' &&
    request.backgroundColor.trim() !== '#1E1E2E' &&
    request.backgroundColor.trim() !== '0x1E1E2E';

  let mainSource: VideoSource;
  if (completeVideoScene) {
    const video = resolvedScenes[0]!;
    const videoRelativePath = relative(DATA_DIR, video.videoPath!).replace(/\\/g, '/');
    mainSource = {
      id: nanoid(),
      filename: videoRelativePath.split('/').pop()!,
      path: `/${videoRelativePath}`,
      duration: video.videoMetadata!.duration,
      width: video.videoMetadata!.width,
      height: video.videoMetadata!.height,
      fps: video.videoMetadata!.fps,
      codec: video.videoMetadata!.codec,
      bitrate: video.videoMetadata!.bitrate,
    };
  } else {
    if (hasCustomSolidColor) {
      await generateBackgroundVideo(request.backgroundColor!, totalDuration, bgFilePath);
    } else {
      await generateSceneBlurredBackgroundVideo(
        resolvedScenes.map(s => ({ imagePath: s.imagePath!, duration: s.duration })),
        bgFilePath
      );
    }

    mainSource = {
      id: nanoid(),
      filename: bgFilename,
      path: `/uploads/${bgFilename}`,
      duration: totalDuration,
      width: 1080,
      height: 1920,
      fps: 30,
      codec: 'h264',
      bitrate: 8000000,
    };
  }

  // Step 3: Prepare overlays, captions, and audios
  const overlayTrackId = nanoid();
  const captionTrackId = nanoid();
  const audioTrackId = nanoid();
  const videoTrackId = nanoid();

  const overlaySources: OverlaySource[] = [];
  const overlaySegments: OverlaySegment[] = [];
  const captionSegments: CaptionSegment[] = [];
  const audioSources: AudioSource[] = [];
  const audioSegments: AudioSegment[] = [];

  for (let i = 0; i < resolvedScenes.length; i++) {
    const scene = resolvedScenes[i];

    // Image scenes retain their character overlay. A complete source video
    // already contains the scene and must not be duplicated as an overlay.
    if (scene.imagePath) {
      const overlayFilename = `novelinha_ov_${projectId}_${i}.webm`;
      const overlayFilePath = join(UPLOADS_DIR, overlayFilename);
      await convertImageToOverlayVideo(
        scene.imagePath,
        scene.duration,
        overlayFilePath,
        scene.cameraMotion
      );

      const overlaySourceId = nanoid();
      overlaySources.push({
        id: overlaySourceId,
        filename: overlayFilename,
        path: `/uploads/${overlayFilename}`,
        duration: scene.duration,
        width: 1080,
        height: 1920,
        fps: 30,
      });

      overlaySegments.push({
        id: nanoid(),
        trackId: overlayTrackId,
        type: 'overlay',
        overlaySourceId,
        startTime: scene.startTime,
        duration: scene.duration,
        sourceStart: 0,
        sourceEnd: scene.duration,
        position: getOverlayPosition(scene.position),
        opacity: 1,
        borderRadius: 0,
        effects: {},
      });
    }

    // Caption segment if text is provided
    if (scene.caption.length > 0) {
      captionSegments.push({
        id: nanoid(),
        trackId: captionTrackId,
        type: 'caption',
        text: scene.caption,
        startTime: scene.startTime,
        duration: scene.duration,
        style: {
          ...DEFAULT_CAPTION_STYLE,
          fontSize: 64,
          position: {
            vertical: 'bottom',
            horizontal: 'center',
            offsetX: 0,
            offsetY: 80,
          },
        },
        effects: {},
      });
    }

    // Audio source & segment
    const audioSourceId = nanoid();
    audioSources.push({
      id: audioSourceId,
      filename: `audio_${i}.mp3`,
      path: scene.audioPath,
      duration: scene.duration,
    });

    audioSegments.push({
      id: nanoid(),
      trackId: audioTrackId,
      type: 'audio',
      audioSourceId,
      startTime: scene.startTime,
      duration: scene.duration,
      sourceStart: 0,
      sourceEnd: scene.duration,
      volume: 1.0,
      fadeInDuration: 0,
      fadeOutDuration: 0,
      muted: false,
      effects: {},
    });
  }

  // Base video segment
  const videoSegment: VideoSegment = {
    id: nanoid(),
    trackId: videoTrackId,
    type: 'video',
    startTime: 0,
    duration: totalDuration,
    sourceStart: 0,
    sourceEnd: totalDuration,
    effects: {},
  };

  // Build full project object
  const project: Project = {
    id: projectId,
    name: projectName,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: mainSource,
    timeline: {
      duration: totalDuration,
      pixelsPerSecond: 100,
      scrollOffset: 0,
      playheadPosition: 0,
      isPlaying: false,
      tracks: [
        {
          id: videoTrackId,
          type: 'video',
          name: 'Background',
          segments: [videoSegment],
        },
        {
          id: overlayTrackId,
          type: 'overlay',
          name: 'Personagens',
          segments: overlaySegments,
        },
        {
          id: captionTrackId,
          type: 'caption',
          name: 'Legendas',
          segments: captionSegments,
        },
        {
          id: audioTrackId,
          type: 'audio',
          name: 'Vozes',
          segments: audioSegments,
        },
      ],
    },
    exportSettings: {
      preset: 'custom',
      width: 1080,
      height: 1920,
      fps: 30,
      bitrate: 8000000,
      codec: 'h264',
      quality: 'high',
      aspectRatio: '9:16',
    },
    overlaySources,
    audioSources,
  };

  // Step 4: Save project to disk for editor compatibility
  await saveProject(project);

  // Step 5: Start export pipeline
  const jobId = nanoid();
  startExport(project, jobId, (progress) => {
    onProgress?.(jobId, progress);
  });

  if (request.wait) {
    const job = await waitForExportJob(jobId);
    return {
      success: true,
      jobId,
      projectId,
      duration: totalDuration,
      outputPath: job.outputPath,
    };
  }

  return {
    success: true,
    jobId,
    projectId,
    duration: totalDuration,
  };
}
