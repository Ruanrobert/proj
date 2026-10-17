import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import type { VideoSegment, Timeline } from '@proj/shared';

interface UseVideoPlaybackParams {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoSegments: VideoSegment[];
  timeline: Timeline | undefined;
  playheadPosition: number;
  isPlaying: boolean;
  setPlayheadPosition: (position: number) => void;
  setIsPlaying: (isPlaying: boolean) => void;
}

interface UseVideoPlaybackResult {
  timelineToSource: (timelinePos: number) => number;
  currentSpeedRate: number;
  isLoading: boolean;
  error: string | null;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

function seekVideo(video: HTMLVideoElement, targetTime: number): Promise<void> {
  if (!video.seeking && Math.abs(video.currentTime - targetTime) <= 0.05) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('seeked', handleSeeked);
      video.removeEventListener('error', handleError);
    };
    const handleSeeked = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error('The video failed while seeking.'));
    };

    video.addEventListener('seeked', handleSeeked, { once: true });
    video.addEventListener('error', handleError, { once: true });

    try {
      video.currentTime = targetTime;
      if (!video.seeking && Math.abs(video.currentTime - targetTime) <= 0.05) {
        cleanup();
        resolve();
      }
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error('The video could not seek.'));
    }
  });
}

export function useVideoPlayback({
  videoRef,
  videoSegments,
  timeline,
  playheadPosition,
  isPlaying,
  setPlayheadPosition,
  setIsPlaying,
}: UseVideoPlaybackParams): UseVideoPlaybackResult {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isSeeking = useRef(false);
  const pendingSeekTime = useRef<number | null>(null);
  const desiredPlaying = useRef(isPlaying);
  const playbackRequestId = useRef(0);
  desiredPlaying.current = isPlaying;

  const timelineToSource = useCallback((timelinePos: number): number => {
    for (const seg of videoSegments) {
      const segEnd = seg.startTime + seg.duration;
      if (timelinePos >= seg.startTime && timelinePos < segEnd) {
        const relativePos = timelinePos - seg.startTime;
        const speedRate = seg.effects.speed?.rate || 1;
        return seg.sourceStart + (relativePos * speedRate);
      }
    }
    return timelinePos;
  }, [videoSegments]);

  useEffect(() => {
    pendingSeekTime.current = playheadPosition;
  }, [playheadPosition]);

  // SINK: Playhead Position -> Video Element
  // Only sync when NOT playing (seeking/scrubbing)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !timeline) return;

    if (isPlaying) return;

    const sourceTime = timelineToSource(playheadPosition);
    const diff = Math.abs(video.currentTime - sourceTime);
    if (diff > 0.1) {
      isSeeking.current = true;
      video.currentTime = sourceTime;
    }
  }, [playheadPosition, isPlaying, timeline, timelineToSource, videoRef]);

  // SOURCE: Play/Pause trigger -> Video Element
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !timeline) return;

    if (isPlaying) {
      if (!video.paused || isSeeking.current) return;

      const requestId = ++playbackRequestId.current;
      const sourceTime = timelineToSource(playheadPosition);
      const startPlayback = async () => {
        try {
          if (Math.abs(video.currentTime - sourceTime) > 0.1) {
            isSeeking.current = true;
            await seekVideo(video, sourceTime);
            isSeeking.current = false;
          }

          if (playbackRequestId.current !== requestId || !desiredPlaying.current) return;
          await video.play();
        } catch (err) {
          isSeeking.current = false;
          if (playbackRequestId.current !== requestId) return;
          console.error('Playback failed:', err);
          setError(err instanceof Error ? err.message : 'The video could not start playing.');
          setIsPlaying(false);
        }
      };

      void startPlayback();
    } else {
      playbackRequestId.current += 1;
      video.pause();
    }
  }, [isPlaying, playheadPosition, setError, setIsPlaying, timeline, timelineToSource, videoRef]);

  const findSegmentAtTimeline = useCallback((timelinePos: number): VideoSegment | null => {
    for (const seg of videoSegments) {
      const segEnd = seg.startTime + seg.duration;
      if (timelinePos >= seg.startTime && timelinePos < segEnd) {
        return seg;
      }
    }
    return null;
  }, [videoSegments]);

  const findNextSegment = useCallback((timelinePos: number, currentSegmentId?: string): VideoSegment | null => {
    const sorted = [...videoSegments].sort((a, b) => a.startTime - b.startTime);
    for (const seg of sorted) {
      if (seg.startTime >= timelinePos - 0.01 && seg.id !== currentSegmentId) {
        return seg;
      }
    }
    return null;
  }, [videoSegments]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      if (!video.paused && !isSeeking.current) {
        const sourceTime = video.currentTime;

        let foundSegment: VideoSegment | null = null;
        for (const seg of videoSegments) {
          if (sourceTime >= seg.sourceStart && sourceTime < seg.sourceEnd) {
            foundSegment = seg;
            break;
          }
        }

        if (foundSegment) {
          const relativeSource = sourceTime - foundSegment.sourceStart;
          const speedRate = foundSegment.effects.speed?.rate || 1;
          const timelinePos = foundSegment.startTime + (relativeSource / speedRate);
          setPlayheadPosition(timelinePos);
        } else {
          const sortedBySource = [...videoSegments].sort((a, b) => a.sourceStart - b.sourceStart);
          let nextSeg: VideoSegment | null = null;
          let prevSeg: VideoSegment | null = null;

          for (const seg of sortedBySource) {
            if (seg.sourceStart > sourceTime) {
              nextSeg = seg;
              break;
            }
            prevSeg = seg;
          }

          if (nextSeg) {
            isSeeking.current = true;
            video.currentTime = nextSeg.sourceStart;
            setPlayheadPosition(nextSeg.startTime);
          } else if (prevSeg) {
            setPlayheadPosition(prevSeg.startTime + prevSeg.duration);
            setIsPlaying(false);
            video.pause();
          } else {
            setIsPlaying(false);
            video.pause();
          }
        }
      }
    };

    const handleEnded = () => {
      const currentTimeline = pendingSeekTime.current ?? 0;
      const currentSegment = findSegmentAtTimeline(currentTimeline);

      if (currentSegment) {
        const nextSeg = findNextSegment(currentSegment.startTime + currentSegment.duration, currentSegment.id);
        if (nextSeg) {
          isSeeking.current = true;
          video.currentTime = nextSeg.sourceStart;
          setPlayheadPosition(nextSeg.startTime);
          const continuePlayback = async () => {
            try {
              await seekVideo(video, nextSeg.sourceStart);
              isSeeking.current = false;
              await video.play();
            } catch (err) {
              isSeeking.current = false;
              console.error('Playback failed while advancing to the next segment:', err);
              setError(err instanceof Error ? err.message : 'The next segment could not start playing.');
              setIsPlaying(false);
            }
          };
          void continuePlayback();
          return;
        }
      }

      setIsPlaying(false);
    };

    const handleSeeked = () => {
      isSeeking.current = false;
    };

    const handlePlaying = () => {
      if (desiredPlaying.current) setIsPlaying(true);
    };

    const handlePause = () => {
      setIsPlaying(false);
    };

    const handleMediaError = () => {
      isSeeking.current = false;
      setIsPlaying(false);
    };

    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('ended', handleEnded);
    video.addEventListener('seeked', handleSeeked);
    video.addEventListener('playing', handlePlaying);
    video.addEventListener('pause', handlePause);
    video.addEventListener('error', handleMediaError);

    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('seeked', handleSeeked);
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('error', handleMediaError);
    };
  }, [setError, setPlayheadPosition, setIsPlaying, videoSegments, findSegmentAtTimeline, findNextSegment, videoRef]);

  const currentVideoSegment = useMemo(() => {
    return videoSegments.find(seg => {
      const start = seg.startTime;
      const end = seg.startTime + seg.duration;
      return playheadPosition >= start && playheadPosition < end;
    }) || null;
  }, [videoSegments, playheadPosition]);

  const currentSpeedRate = useMemo(() => {
    if (!currentVideoSegment) return 1;
    return currentVideoSegment.effects.speed?.rate || 1;
  }, [currentVideoSegment]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (Math.abs(video.playbackRate - currentSpeedRate) > 0.01) {
      video.playbackRate = currentSpeedRate;
    }
  }, [currentSpeedRate, videoRef]);

  return {
    timelineToSource,
    currentSpeedRate,
    isLoading,
    error,
    setLoading: setIsLoading,
    setError: setError,
  };
}
