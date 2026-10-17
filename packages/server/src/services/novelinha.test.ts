import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { spawn } from 'bun';
import { unlink } from 'fs/promises';
import {
  sanitizeColor,
  validateAndResolvePath,
  getAudioDuration,
  getOverlayPosition,
  normalizeCameraMotion,
  convertImageToOverlayVideo,
  generateSceneBlurredBackgroundVideo,
  assembleNovelinha,
  ValidationError,
} from './novelinha';
import { getProject } from './projects';
import { FFPROBE_PATH, FFMPEG_PATH } from '@proj/ffmpeg';

const DATA_DIR = join(import.meta.dir, '../../../../data');
const UPLOADS_DIR = join(DATA_DIR, 'uploads');

describe('Novelinha Service - Unit & Security Tests', () => {
  it('sanitizeColor validates and converts colors correctly', () => {
    expect(sanitizeColor('#FFFFFF')).toBe('0xFFFFFF');
    expect(sanitizeColor('#1e1e2e')).toBe('0x1e1e2e');
    expect(sanitizeColor('#fff')).toBe('0xffffff');
    expect(sanitizeColor('red')).toBe('red');
    expect(sanitizeColor('blue')).toBe('blue');
    expect(sanitizeColor('')).toBe('0x1E1E2E');
    expect(sanitizeColor(undefined)).toBe('0x1E1E2E');

    expect(() => sanitizeColor('invalid;rm -rf /')).toThrow(ValidationError);
    expect(() => sanitizeColor('#1234567')).toThrow(ValidationError);
    expect(() => sanitizeColor('rgb(255,0,0)')).toThrow(ValidationError);
  });

  it('normalizeCameraMotion normalizes motions and accepts Portuguese/English synonyms', () => {
    expect(normalizeCameraMotion('zoom_in')).toBe('zoom_in');
    expect(normalizeCameraMotion('aproximacao')).toBe('zoom_in');
    expect(normalizeCameraMotion('aproximação')).toBe('zoom_in');
    expect(normalizeCameraMotion('zoom_out')).toBe('zoom_out');
    expect(normalizeCameraMotion('afastamento')).toBe('zoom_out');
    expect(normalizeCameraMotion('pan_left')).toBe('pan_left');
    expect(normalizeCameraMotion('lateral_esquerda')).toBe('pan_left');
    expect(normalizeCameraMotion('pan_right')).toBe('pan_right');
    expect(normalizeCameraMotion('lateral_direita')).toBe('pan_right');
    expect(normalizeCameraMotion('lateral')).toBe('pan_right');
    expect(normalizeCameraMotion('pan_up')).toBe('pan_up');
    expect(normalizeCameraMotion('pan_down')).toBe('pan_down');
    expect(normalizeCameraMotion('none')).toBe('none');
    expect(normalizeCameraMotion('estatico')).toBe('none');
    expect(normalizeCameraMotion(undefined)).toBe('none');

    expect(() => normalizeCameraMotion('invalid_motion')).toThrow(ValidationError);
  });

  it('getOverlayPosition returns correct bounding boxes for left, center, right', () => {
    const left = getOverlayPosition('left');
    expect(left.x).toBe(0.05);
    expect(left.width).toBe(0.50);

    const center = getOverlayPosition('center');
    expect(center.x).toBe(0.25);
    expect(center.width).toBe(0.50);

    const right = getOverlayPosition('right');
    expect(right.x).toBe(0.45);
    expect(right.width).toBe(0.50);
  });

  it('validateAndResolvePath blocks path traversal attempts', async () => {
    const allowedImages = new Set(['.png', '.jpg']);

    // Attempt traversal outside DATA_DIR
    await expect(
      validateAndResolvePath('../../../Windows/System32/calc.exe', allowedImages, 'image')
    ).rejects.toThrow(ValidationError);

    await expect(
      validateAndResolvePath('/etc/passwd', allowedImages, 'image')
    ).rejects.toThrow(ValidationError);

    await expect(
      validateAndResolvePath('..\\..\\secret.txt', allowedImages, 'image')
    ).rejects.toThrow(ValidationError);
  });

  it('validateAndResolvePath blocks disallowed file extensions', async () => {
    const allowedImages = new Set(['.png', '.jpg']);

    await expect(
      validateAndResolvePath('/uploads/script.sh', allowedImages, 'image')
    ).rejects.toThrow(ValidationError);
  });

  it('assembleNovelinha rejects empty scenes list', async () => {
    await expect(
      assembleNovelinha({ scenes: [] })
    ).rejects.toThrow(ValidationError);
  });

  it('assembleNovelinha rejects invalid scene position', async () => {
    await expect(
      assembleNovelinha({
        scenes: [
          {
            imagePath: '/uploads/dummy.png',
            audioPath: '/uploads/dummy.mp3',
            captionText: 'test',
            position: 'top' as any,
          },
        ],
      })
    ).rejects.toThrow(ValidationError);
  });
});

describe('Novelinha Service - End-to-End Assembly Test', () => {
  const testImg1Path = join(UPLOADS_DIR, 'test_strawberry.png');
  const testImg2Path = join(UPLOADS_DIR, 'test_banana.png');
  const testAudio1Path = join(UPLOADS_DIR, 'test_voice1.wav');
  const testAudio2Path = join(UPLOADS_DIR, 'test_voice2.wav');
  const testCompleteVideoPath = join(UPLOADS_DIR, 'test_complete_scene.mp4');
  const testAudioOnlyMp4Path = join(UPLOADS_DIR, 'test_audio_only.mp4');

  let generatedVideoPath: string | null = null;
  let createdProjectId: string | null = null;

  beforeAll(async () => {
    // Generate test asset 1: strawberry (red rectangle PNG with alpha)
    const procImg1 = spawn({
      cmd: [
        FFMPEG_PATH, '-y',
        '-f', 'lavfi',
        '-i', 'color=c=red@0.9:size=300x300,format=rgba',
        '-frames:v', '1',
        testImg1Path,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await procImg1.exited;

    // Generate test asset 2: banana (yellow rectangle PNG with alpha)
    const procImg2 = spawn({
      cmd: [
        FFMPEG_PATH, '-y',
        '-f', 'lavfi',
        '-i', 'color=c=yellow@0.9:size=300x300,format=rgba',
        '-frames:v', '1',
        testImg2Path,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await procImg2.exited;

    // Generate test voice 1: 1.0 second sine wave audio
    const procAud1 = spawn({
      cmd: [
        FFMPEG_PATH, '-y',
        '-f', 'lavfi',
        '-i', 'sine=frequency=440:duration=1.0',
        testAudio1Path,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await procAud1.exited;

    // Generate test voice 2: 1.5 second sine wave audio
    const procAud2 = spawn({
      cmd: [
        FFMPEG_PATH, '-y',
        '-f', 'lavfi',
        '-i', 'sine=frequency=880:duration=1.5',
        testAudio2Path,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await procAud2.exited;

    const procVideo = spawn({
      cmd: [
        FFMPEG_PATH, '-y', '-f', 'lavfi', '-i', 'color=c=blue:size=320x480:rate=24',
        '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', testCompleteVideoPath,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await procVideo.exited;

    const procAudioOnly = spawn({
      cmd: [
        FFMPEG_PATH, '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5',
        '-c:a', 'aac', '-t', '0.5', testAudioOnlyMp4Path,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await procAudioOnly.exited;
  });

  afterAll(async () => {
    // Clean up test source assets
    try { await unlink(testImg1Path); } catch {}
    try { await unlink(testImg2Path); } catch {}
    try { await unlink(testAudio1Path); } catch {}
    try { await unlink(testAudio2Path); } catch {}
    try { await unlink(testCompleteVideoPath); } catch {}
    try { await unlink(testAudioOnlyMp4Path); } catch {}
  });

  it('measures audio durations accurately with getAudioDuration', async () => {
    const dur1 = await getAudioDuration(testAudio1Path);
    const dur2 = await getAudioDuration(testAudio2Path);

    expect(dur1).toBeGreaterThanOrEqual(0.9);
    expect(dur1).toBeLessThanOrEqual(1.1);

    expect(dur2).toBeGreaterThanOrEqual(1.4);
    expect(dur2).toBeLessThanOrEqual(1.6);
  });

  it('uses a validated complete video as the project source without generating a duplicate overlay', async () => {
    const result = await assembleNovelinha({
      title: 'Complete video scene test',
      wait: true,
      scenes: [{
        mediaPath: '/uploads/test_complete_scene.mp4',
        audioPath: '/uploads/test_voice1.wav',
        captionText: 'Caption over the complete scene',
      }],
    });

    expect(result.success).toBe(true);
    const savedProject = await getProject(result.projectId!);
    expect(savedProject?.source.path).toBe('/uploads/test_complete_scene.mp4');
    expect(savedProject?.source.width).toBe(320);
    expect(savedProject?.source.height).toBe(480);
    expect(savedProject?.timeline.tracks.find(track => track.name === 'Background')?.segments).toHaveLength(1);
    expect(savedProject?.timeline.tracks.find(track => track.name === 'Legendas')?.segments).toHaveLength(1);
    expect(savedProject?.timeline.tracks.find(track => track.name === 'Personagens')?.segments).toHaveLength(0);
    expect(savedProject?.overlaySources).toHaveLength(0);
  }, 60000);

  it('rejects an image passed as mediaPath instead of treating every media path as a video', async () => {
    await expect(assembleNovelinha({
      scenes: [{
        mediaPath: '/uploads/test_strawberry.png',
        audioPath: '/uploads/test_voice1.wav',
      }],
    })).rejects.toThrow(ValidationError);
  });

  it('rejects a video extension when ffprobe finds no video stream', async () => {
    await expect(assembleNovelinha({
      scenes: [{
        mediaPath: '/uploads/test_audio_only.mp4',
        audioPath: '/uploads/test_voice1.wav',
      }],
    })).rejects.toThrow('Invalid video media');
  });

  it('generates smooth camera motion overlays for zoom_in, zoom_out and pan_left', async () => {
    const staticOutput = join(UPLOADS_DIR, 'test_overlay_static.webm');
    const zoomInOutput = join(UPLOADS_DIR, 'test_motion_zoom_in.webm');
    const zoomOutOutput = join(UPLOADS_DIR, 'test_motion_zoom_out.webm');
    const panLeftOutput = join(UPLOADS_DIR, 'test_motion_pan_left.webm');

    try {
      await convertImageToOverlayVideo(testImg1Path, 1.0, staticOutput, 'none');
      expect(await Bun.file(staticOutput).exists()).toBe(true);

      // 1. Zoom In (aproximação)
      await convertImageToOverlayVideo(testImg1Path, 1.0, zoomInOutput, 'zoom_in');
      expect(await Bun.file(zoomInOutput).exists()).toBe(true);

      // 2. Zoom Out (afastamento)
      await convertImageToOverlayVideo(testImg1Path, 1.0, zoomOutOutput, 'zoom_out');
      expect(await Bun.file(zoomOutOutput).exists()).toBe(true);

      // 3. Pan Left (movimento lateral)
      await convertImageToOverlayVideo(testImg2Path, 1.0, panLeftOutput, 'pan_left');
      expect(await Bun.file(panLeftOutput).exists()).toBe(true);

      // Probe stream of generated motion overlay to verify alpha and frame count
      const probeProc = spawn({
        cmd: [
          FFPROBE_PATH,
          '-v', 'quiet',
          '-print_format', 'json',
          '-count_frames',
          '-show_streams',
          zoomInOutput,
        ],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const probeText = await new Response(probeProc.stdout).text();
      await probeProc.exited;

      const data = JSON.parse(probeText);
      const stream = data.streams.find((s: any) => s.codec_type === 'video');
      expect(stream).toBeDefined();
      expect(stream.codec_name).toBe('vp9');
      expect(stream.tags?.alpha_mode).toBe('1');
      expect(stream.width).toBe(300);
      expect(stream.height).toBe(300);
      expect(parseInt(stream.nb_read_frames, 10)).toBe(30);
    } finally {
      try { await unlink(staticOutput); } catch {}
      try { await unlink(zoomInOutput); } catch {}
      try { await unlink(zoomOutOutput); } catch {}
      try { await unlink(panLeftOutput); } catch {}
    }
  });

  it('generates vertical 9:16 blurred background from scene images filling the whole frame', async () => {
    const bgOutput = join(UPLOADS_DIR, 'test_blurred_bg.mp4');
    try {
      await generateSceneBlurredBackgroundVideo(
        [
          { imagePath: testImg1Path, duration: 1.0 },
          { imagePath: testImg2Path, duration: 1.5 },
        ],
        bgOutput
      );

      const file = Bun.file(bgOutput);
      expect(await file.exists()).toBe(true);

      const probeProc = spawn({
        cmd: [
          FFPROBE_PATH,
          '-v', 'quiet',
          '-print_format', 'json',
          '-show_format',
          '-show_streams',
          bgOutput,
        ],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const probeText = await new Response(probeProc.stdout).text();
      await probeProc.exited;

      const data = JSON.parse(probeText);
      const vStream = data.streams.find((s: any) => s.codec_type === 'video');
      expect(vStream).toBeDefined();
      expect(vStream.width).toBe(1080);
      expect(vStream.height).toBe(1920);

      const duration = parseFloat(data.format.duration);
      expect(duration).toBeGreaterThanOrEqual(2.4);
    } finally {
      try { await unlink(bgOutput); } catch {}
    }
  });

  it('assembles a full 2-scene vertical novelinha video with camera motion and wait: true', async () => {
    const result = await assembleNovelinha({
      title: 'A Grande Aventura das Frutas com Movimento',
      backgroundColor: '#1E1E2E',
      wait: true,
      scenes: [
        {
          imagePath: '/uploads/test_strawberry.png',
          audioPath: '/uploads/test_voice1.wav',
          captionText: 'Olá! Eu sou o Moranguinho em aproximação!',
          position: 'left',
          cameraMotion: 'zoom_in',
        },
        {
          imagePath: '/uploads/test_banana.png',
          audioPath: '/uploads/test_voice2.wav',
          captionText: 'E eu sou o Bananinha com movimento lateral!',
          position: 'right',
          cameraMotion: 'pan_right',
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.jobId).toBeDefined();
    expect(result.projectId).toBeDefined();
    expect(result.outputPath).toBeDefined();
    expect(result.duration).toBeGreaterThan(2.0);

    createdProjectId = result.projectId!;
    generatedVideoPath = join(DATA_DIR, result.outputPath!.replace(/^\//, ''));

    // Check project was saved for editor compatibility
    const savedProject = await getProject(result.projectId!);
    expect(savedProject).not.toBeNull();
    expect(savedProject?.name).toBe('A Grande Aventura das Frutas com Movimento');
    expect(savedProject?.timeline.tracks.length).toBe(4);
    expect(savedProject?.exportSettings.width).toBe(1080);
    expect(savedProject?.exportSettings.height).toBe(1920);
    expect(savedProject?.overlaySources?.[0]?.filename).toMatch(/\.webm$/);
    expect(savedProject?.overlaySources?.[0]?.path).toMatch(/\.webm$/);

    // Verify output video file exists and has content
    const videoFile = Bun.file(generatedVideoPath);
    expect(await videoFile.exists()).toBe(true);
    expect(videoFile.size).toBeGreaterThan(10000);

    // Probe output video file with ffprobe to verify 1080x1920 vertical format and audio stream
    const probeProc = spawn({
      cmd: [
        FFPROBE_PATH,
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        generatedVideoPath,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const probeText = await new Response(probeProc.stdout).text();
    await probeProc.exited;

    const probeData = JSON.parse(probeText);
    const vStream = probeData.streams.find((s: any) => s.codec_type === 'video');
    const aStream = probeData.streams.find((s: any) => s.codec_type === 'audio');

    expect(vStream).toBeDefined();
    expect(vStream.width).toBe(1080);
    expect(vStream.height).toBe(1920);
    expect(aStream).toBeDefined();

    const fileDuration = parseFloat(probeData.format.duration);
    expect(fileDuration).toBeGreaterThanOrEqual(2.0);
  }, 90000); // 90s timeout for FFmpeg assembly pass
});
