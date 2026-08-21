import type {
  AudioStatsEvent,
  NativeTelemetry,
} from '../../../modules/snap-native/src/SnapNative.types';
import type { AnalysisTargetFps } from '../slice-one/analysis-profile';

export type SessionState = 'idle' | 'starting' | 'running' | 'stopping';
export type CameraPosition = 'back' | 'front';

export type Metrics = {
  inputFrames: number;
  previewFps: number;
  analysisRequested: number;
  analysisAccepted: number;
  analysisRejected: number;
  analysisFps: number;
  droppedFrames: number;
  detectionCount: number;
  gateP50Ms: number;
  gateP95Ms: number;
  brightness: number;
  clippedRatio: number;
  motion: number;
  qualityScore: number;
  sharpness: number;
  lastBarcode: string;
  objectConfidence: number;
  objectLabel: string;
  barcodeScans: number;
  resizeResult: string;
  trackId: string;
};

export const EMPTY_METRICS: Metrics = {
  inputFrames: 0,
  previewFps: 0,
  analysisRequested: 0,
  analysisAccepted: 0,
  analysisRejected: 0,
  analysisFps: 0,
  droppedFrames: 0,
  detectionCount: 0,
  gateP50Ms: 0,
  gateP95Ms: 0,
  brightness: 0,
  clippedRatio: 0,
  motion: 0,
  qualityScore: 0,
  sharpness: 0,
  lastBarcode: 'none',
  objectConfidence: 0,
  objectLabel: 'none',
  barcodeScans: 0,
  resizeResult: 'pending',
  trackId: 'none',
};

export type SliceOneViewState = {
  analysisTargetFps: AnalysisTargetFps;
  audioStats: AudioStatsEvent | null;
  cameraConfigured: boolean;
  cameraPosition: CameraPosition;
  cameraPreviewStarted: boolean;
  captureStatus: string;
  currentItemIndex: number;
  elapsedMs: number;
  errorMessage: string | null;
  exportUri: string | null;
  identificationStatus: string;
  isCapturing: boolean;
  metrics: Metrics;
  modelProbeRequested: boolean;
  modelResult: string;
  qualityGateStatus: string;
  sessionEndedAt: number | null;
  sessionStartedAt: number | null;
  sessionState: SessionState;
  telemetry: NativeTelemetry | null;
};

export function createInitialSliceOneViewState(): SliceOneViewState {
  return {
    analysisTargetFps: 5,
    audioStats: null,
    cameraConfigured: false,
    cameraPosition: 'back',
    cameraPreviewStarted: false,
    captureStatus: 'No photo captured',
    currentItemIndex: 1,
    elapsedMs: 0,
    errorMessage: null,
    exportUri: null,
    identificationStatus: 'Identity API waiting for a completed item',
    isCapturing: false,
    metrics: { ...EMPTY_METRICS },
    modelProbeRequested: false,
    modelResult: 'Model probe not started',
    qualityGateStatus: 'Waiting for a stable view',
    sessionEndedAt: null,
    sessionStartedAt: null,
    sessionState: 'idle',
    telemetry: null,
  };
}
