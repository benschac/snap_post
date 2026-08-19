import { NativeModule, requireOptionalNativeModule } from 'expo';

import type {
  AudioCaptureStart,
  AudioCaptureStop,
  NativeCapabilities,
  NativeTelemetry,
  SnapNativeEvents,
} from './SnapNative.types';

declare class SnapNativeModule extends NativeModule<SnapNativeEvents> {
  getCapabilities(): NativeCapabilities;
  startPcmCapture(chunkDurationMs: number): Promise<AudioCaptureStart>;
  stopPcmCapture(): Promise<AudioCaptureStop>;
  getTelemetry(): NativeTelemetry;
  mark(name: string, attributes?: string): void;
  beginSpan(name: string, attributes?: string): string;
  endSpan(spanId: string, name: string, attributes?: string): void;
}

export default requireOptionalNativeModule<SnapNativeModule>('SnapNative');
