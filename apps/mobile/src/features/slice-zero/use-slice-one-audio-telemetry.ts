import type { Observable } from '@legendapp/state';
import { useCallback, useEffect, useRef, type RefObject } from 'react';

import SnapNative from '../../../modules/snap-native/src/SnapNativeModule';
import type { AudioStatsEvent } from '../../../modules/snap-native/src/SnapNative.types';
import { formatError } from './format-error';
import type { SessionState, SliceOneViewState } from './slice-one-view-state';
import type { SliceTrace } from './trace';

const AUDIO_STATS_UI_STRIDE = 10;

type UseSliceOneAudioTelemetryOptions = {
  sessionState: SessionState;
  state$: Observable<SliceOneViewState>;
  traceRef: RefObject<SliceTrace | null>;
};

export function useSliceOneAudioTelemetry({
  sessionState,
  state$,
  traceRef,
}: UseSliceOneAudioTelemetryOptions) {
  const audioStatsRef = useRef<AudioStatsEvent | null>(null);

  useEffect(() => {
    if (!SnapNative) return;

    const statsSubscription = SnapNative.addListener('onAudioStats', (event) => {
      audioStatsRef.current = event;
      if (event.chunkIndex === 1 || event.chunkIndex % AUDIO_STATS_UI_STRIDE === 0) {
        state$.audioStats.set(event);
        traceRef.current?.mark('speech.pcm_chunk', {
          chunkIndex: event.chunkIndex,
          frames: event.frames,
          rms: event.rms,
          startupLatencyMs: event.startupLatencyMs || undefined,
        });
      }
    });
    const errorSubscription = SnapNative.addListener('onAudioError', (event) => {
      state$.errorMessage.set(`Audio capture: ${event.message}`);
      traceRef.current?.mark('speech.capture.error', { message: event.message });
    });

    return () => {
      statsSubscription.remove();
      errorSubscription.remove();
    };
  }, [state$, traceRef]);

  useEffect(() => {
    if (sessionState !== 'running' || !SnapNative) return;
    const nativeModule = SnapNative;

    const poll = () => {
      const nextTelemetry = nativeModule.getTelemetry();
      state$.telemetry.set(nextTelemetry);
      traceRef.current?.mark('telemetry.sample', {
        thermalState: nextTelemetry.thermalState,
        residentMemoryBytes: nextTelemetry.residentMemoryBytes,
      });
    };
    poll();
    const timer = setInterval(poll, 5_000);
    return () => clearInterval(timer);
  }, [sessionState, state$, traceRef]);

  useEffect(() => () => {
    void SnapNative?.stopPcmCapture();
  }, []);

  const reset = useCallback(() => {
    audioStatsRef.current = null;
    state$.audioStats.set(null);
    state$.telemetry.set(null);
  }, [state$]);

  const start = useCallback(async (sessionId: string, trace: SliceTrace) => {
    if (!SnapNative) {
      trace.mark('speech.capture.unavailable');
      state$.errorMessage.set('SnapNative is not linked; raw PCM capture is unavailable.');
      return;
    }

    const audioSpan = trace.beginSpan('speech.microphone_start');
    const nativeAudioSpan = SnapNative.beginSpan('speech.microphone_start', sessionId);
    try {
      const audioStart = await SnapNative.startPcmCapture(80);
      trace.endSpan(audioSpan, {
        sampleRate: audioStart.sampleRate,
        chunkDurationMs: audioStart.chunkDurationMs,
      });
      SnapNative.endSpan(nativeAudioSpan, 'speech.microphone_start', 'ready');
    } catch (error) {
      const message = formatError(error);
      trace.endSpan(audioSpan, { error: message });
      SnapNative.endSpan(nativeAudioSpan, 'speech.microphone_start', message);
      state$.errorMessage.set(`Raw PCM capture failed: ${message}`);
    }
  }, [state$]);

  const stop = useCallback(async () => {
    try {
      const audioStop = await SnapNative?.stopPcmCapture();
      traceRef.current?.mark('speech.microphone_stopped', {
        chunks: audioStop?.chunks,
        durationMs: audioStop?.durationMs,
      });
    } catch (error) {
      traceRef.current?.mark('speech.stop.error', { message: formatError(error) });
    }
  }, [traceRef]);

  return { audioStatsRef, reset, start, stop };
}
