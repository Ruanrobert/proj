import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { spawn } from 'bun';
import { unlink } from 'fs/promises';
import { app } from './index';
import { FFMPEG_PATH } from '@proj/ffmpeg';
import { getProject } from './services/projects';

const DATA_DIR = join(import.meta.dir, '../../../data');
const UPLOADS_DIR = join(DATA_DIR, 'uploads');

describe('HTTP Endpoint POST /api/novelinha/assemble', () => {
  const testImg = join(UPLOADS_DIR, 'http_test_fruit.png');
  const testAudio = join(UPLOADS_DIR, 'http_test_audio.wav');
  const testOverlayWebm = join(UPLOADS_DIR, 'http_test_overlay.webm');
  const testOverlayMov = join(UPLOADS_DIR, 'http_test_overlay.mov');
  const testCompleteVideo = join(UPLOADS_DIR, 'http_test_complete_scene.mp4');

  beforeAll(async () => {
    // Generate small test png
    const p1 = spawn({
      cmd: [FFMPEG_PATH, '-y', '-f', 'lavfi', '-i', 'color=c=orange:size=200x200', '-frames:v', '1', testImg],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await p1.exited;

    // Generate small test audio
    const p2 = spawn({
      cmd: [FFMPEG_PATH, '-y', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=0.5', testAudio],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await p2.exited;

    const p3 = spawn({
      cmd: [
        FFMPEG_PATH, '-y', '-f', 'lavfi', '-i', 'color=c=red:size=16x16',
        '-t', '0.1', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', testOverlayWebm,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await p3.exited;

    const p4 = spawn({
      cmd: [
        FFMPEG_PATH, '-y', '-f', 'lavfi', '-i', 'color=c=red:size=16x16',
        '-t', '0.1', '-c:v', 'png', testOverlayMov,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await p4.exited;

    const p5 = spawn({
      cmd: [
        FFMPEG_PATH, '-y', '-f', 'lavfi', '-i', 'color=c=blue:size=320x480:rate=24',
        '-t', '0.6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', testCompleteVideo,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await p5.exited;
  });

  afterAll(async () => {
    try { await unlink(testImg); } catch {}
    try { await unlink(testAudio); } catch {}
    try { await unlink(testOverlayWebm); } catch {}
    try { await unlink(testOverlayMov); } catch {}
    try { await unlink(testCompleteVideo); } catch {}
  });

  it('serves video MIME types according to the file extension', async () => {
    const webmResponse = await app.fetch(
      new Request('http://localhost/uploads/http_test_overlay.webm', {
        headers: { Range: 'bytes=0-0' },
      })
    );
    expect(webmResponse.status).toBe(206);
    expect(webmResponse.headers.get('Content-Type')).toBe('video/webm');

    const movResponse = await app.fetch(
      new Request('http://localhost/uploads/http_test_overlay.mov', {
        headers: { Range: 'bytes=0-0' },
      })
    );
    expect(movResponse.status).toBe(206);
    expect(movResponse.headers.get('Content-Type')).toBe('video/quicktime');
  });

  it('returns 400 when scenes array is missing or empty', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/novelinha/assemble', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenes: [] }),
      })
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toContain('At least one scene is required');
  });

  it('returns 400 when an invalid file path or path traversal is passed', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/novelinha/assemble', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenes: [
            {
              imagePath: '../../windows/system32/cmd.exe',
              audioPath: '/uploads/http_test_audio.wav',
              captionText: 'teste',
              position: 'center',
            },
          ],
        }),
      })
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toContain('Access denied');
  });

  it('returns 200 with jobId and projectId on valid request', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/novelinha/assemble', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Frutinhas HTTP Test',
          backgroundColor: '#2D1B4E',
          wait: true,
          scenes: [
            {
              imagePath: '/uploads/http_test_fruit.png',
              audioPath: '/uploads/http_test_audio.wav',
              captionText: 'Olá do endpoint HTTP!',
              position: 'center',
              cameraMotion: 'zoom_in',
            },
          ],
        }),
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.jobId).toBeDefined();
    expect(json.projectId).toBeDefined();
    expect(json.outputPath).toBeDefined();
    expect(json.duration).toBeGreaterThan(0.4);
  }, 60000);

  it('uses a complete video as the main source and does not create a duplicate character overlay', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/novelinha/assemble', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Complete video endpoint test',
          wait: true,
          scenes: [{
            mediaPath: '/uploads/http_test_complete_scene.mp4',
            audioPath: '/uploads/http_test_audio.wav',
            captionText: 'Legenda preservada',
          }],
        }),
      })
    );

    expect(res.status).toBe(200);
    const response = await res.json();
    expect(response.success).toBe(true);
    const project = await getProject(response.projectId);
    expect(project?.source.path).toBe('/uploads/http_test_complete_scene.mp4');
    expect(project?.timeline.tracks.find(track => track.name === 'Legendas')?.segments).toHaveLength(1);
    expect(project?.timeline.tracks.find(track => track.name === 'Personagens')?.segments).toHaveLength(0);
    expect(project?.overlaySources).toHaveLength(0);
  }, 60000);

  it('rejects an image file supplied as mediaPath', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/novelinha/assemble', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenes: [{
            mediaPath: '/uploads/http_test_fruit.png',
            audioPath: '/uploads/http_test_audio.wav',
          }],
        }),
      })
    );

    expect(res.status).toBe(400);
    const response = await res.json();
    expect(response.error).toContain('Invalid video extension');
  });
});
