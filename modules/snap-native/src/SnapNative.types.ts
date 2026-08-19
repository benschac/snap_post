export type MicrophonePermission = 'granted' | 'denied' | 'undetermined' | 'unknown';
export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown';

export type NativeCapabilities = {
  pcmCapture: boolean;
  sampleRate: number;
  microphonePermission: MicrophonePermission;
  signposts: boolean;
  thermalTelemetry: boolean;
};

export type AudioCaptureStart = {
  sampleRate: number;
  channels: number;
  chunkDurationMs: number;
  startedAtMs: number;
};

export type AudioCaptureStop = {
  wasCapturing: boolean;
  chunks: number;
  totalFrames: number;
  durationMs: number;
};

export type AudioStatsEvent = {
  chunkIndex: number;
  sampleRate: number;
  frames: number;
  totalFrames: number;
  rms: number;
  peak: number;
  monotonicTimeMs: number;
  startupLatencyMs: number;
};

export type AudioErrorEvent = {
  message: string;
};

export type NativeTelemetry = {
  thermalState: ThermalState;
  residentMemoryBytes: number;
  monotonicTimeMs: number;
};

export type SnapNativeEvents = {
  onAudioStats: (event: AudioStatsEvent) => void;
  onAudioError: (event: AudioErrorEvent) => void;
};
