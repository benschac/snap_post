import type { Observable } from '@legendapp/state';
import { useValue } from '@legendapp/state/react';
import { Canvas, Circle, Line, RoundedRect, vec } from '@shopify/react-native-skia';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { NitroImage, type Image } from 'react-native-nitro-image';

import {
  ANALYSIS_TARGET_FPS_OPTIONS,
  type AnalysisTargetFps,
} from '../slice-one/analysis-profile';
import {
  SCAN_GUIDE_HORIZONTAL_INSET,
  type ScanGuideLayout,
} from '../slice-one/scan-guide-layout';
import type { CameraPosition, SliceOneViewState } from './slice-one-view-state';

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function formatBytes(bytes: number) {
  return bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(0)} MB` : 'n/a';
}

function ActionButton({
  label,
  tone = 'secondary',
  disabled = false,
  onPress,
}: {
  label: string;
  tone?: 'primary' | 'danger' | 'secondary';
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        tone === 'primary' && styles.actionButtonPrimary,
        tone === 'danger' && styles.actionButtonDanger,
        pressed && !disabled && styles.actionButtonPressed,
        disabled && styles.actionButtonDisabled,
      ]}>
      <Text style={styles.actionButtonText}>{label}</Text>
    </Pressable>
  );
}

function GatePill({ label, status }: { label: string; status: 'error' | 'pending' | 'ready' }) {
  return (
    <View
      style={[
        styles.gatePill,
        status === 'ready' && styles.gatePillReady,
        status === 'error' && styles.gatePillError,
      ]}>
      <View
        style={[
          styles.gateDot,
          status === 'ready' && styles.gateDotReady,
          status === 'error' && styles.gateDotError,
        ]}
      />
      <Text style={styles.gatePillText}>{label}</Text>
    </View>
  );
}

function AnalysisProfileButton({
  disabled,
  fps,
  selected,
  onPress,
}: {
  disabled: boolean;
  fps: AnalysisTargetFps;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={`${fps} analysis frames per second`}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.profileButton,
        selected && styles.profileButtonSelected,
        pressed && !disabled && styles.actionButtonPressed,
        disabled && styles.actionButtonDisabled,
      ]}>
      <Text style={[styles.profileButtonText, selected && styles.profileButtonTextSelected]}>
        {fps} fps
      </Text>
    </Pressable>
  );
}

export function SliceOneScanGuide({
  previewHeight,
  previewWidth,
  scanGuide,
  state$,
}: {
  previewHeight: number;
  previewWidth: number;
  scanGuide: ScanGuideLayout;
  state$: Observable<SliceOneViewState>;
}) {
  const overlayColor = useValue(() => {
    if (state$.sessionState.get() !== 'running') return '#A8B1C4';
    return state$.metrics.qualityScore.get() >= 0.56 ? '#6DF5A8' : '#F6C85F';
  });

  return (
    <View pointerEvents="none" style={styles.scanGuideLayer}>
      <Canvas style={StyleSheet.absoluteFill}>
        <RoundedRect
          x={SCAN_GUIDE_HORIZONTAL_INSET}
          y={scanGuide.top}
          width={scanGuide.width}
          height={scanGuide.height}
          r={26}
          color={overlayColor}
          style="stroke"
          strokeWidth={3}
        />
        <Circle
          cx={previewWidth / 2}
          cy={scanGuide.top + scanGuide.height / 2}
          r={4}
          color={overlayColor}
        />
        <Line
          p1={vec(previewWidth / 2 - 22, scanGuide.top + scanGuide.height / 2)}
          p2={vec(previewWidth / 2 + 22, scanGuide.top + scanGuide.height / 2)}
          color={overlayColor}
          strokeWidth={1}
        />
        <Line
          p1={vec(previewWidth / 2, scanGuide.top + scanGuide.height / 2 - 22)}
          p2={vec(previewWidth / 2, scanGuide.top + scanGuide.height / 2 + 22)}
          color={overlayColor}
          strokeWidth={1}
        />
      </Canvas>
    </View>
  );
}

export function SliceOneStatusPanel({
  detectorError,
  detectorReady,
  latestImage,
  onLayout,
  primaryPreviewImage,
  qualityFrameSize,
  state$,
}: {
  detectorError: boolean;
  detectorReady: boolean;
  latestImage: Image | null;
  onLayout: (event: LayoutChangeEvent) => void;
  primaryPreviewImage?: Image;
  qualityFrameSize: number;
  state$: Observable<SliceOneViewState>;
}) {
  const sessionState = useValue(state$.sessionState);
  const currentItemIndex = useValue(state$.currentItemIndex);
  const qualityGateStatus = useValue(state$.qualityGateStatus);
  const cameraReady = useValue(
    () => state$.cameraConfigured.get() && state$.cameraPreviewStarted.get()
  );
  const metrics = useValue(state$.metrics);
  const hasAudio = useValue(() => state$.audioStats.get() !== null);

  return (
    <View style={styles.topPanel} onLayout={onLayout}>
      <View style={styles.headingRow}>
        <View>
          <Text style={styles.eyebrow}>SLICE 1 · ZERO-TAP CAPTURE</Text>
          <Text style={styles.heading}>
            {sessionState === 'running'
              ? `Item ${currentItemIndex} · ${qualityGateStatus}`
              : 'Ready to scan'}
          </Text>
        </View>
        {primaryPreviewImage ? (
          <NitroImage image={primaryPreviewImage} style={styles.thumbnail} />
        ) : latestImage ? (
          <NitroImage image={latestImage} style={styles.thumbnail} />
        ) : null}
      </View>

      <View style={styles.gateRow}>
        <GatePill label="Camera" status={cameraReady ? 'ready' : 'pending'} />
        <GatePill
          label="Worklet"
          status={metrics.analysisAccepted > 0 ? 'ready' : 'pending'}
        />
        <GatePill
          label="RGB sample"
          status={
            metrics.resizeResult === `${qualityFrameSize}×${qualityFrameSize}`
              ? 'ready'
              : 'pending'
          }
        />
        <GatePill
          label="Quality"
          status={metrics.qualityScore >= 0.56 ? 'ready' : 'pending'}
        />
        <GatePill
          label="Barcode"
          status={metrics.barcodeScans > 0 ? 'ready' : 'pending'}
        />
        <GatePill
          label="Detector"
          status={detectorError ? 'error' : detectorReady ? 'ready' : 'pending'}
        />
        <GatePill label="PCM" status={hasAudio ? 'ready' : 'pending'} />
      </View>

      <View style={styles.metricsGrid}>
        <View style={styles.metricCell}>
          <Text style={styles.metricValue}>{(metrics.qualityScore * 100).toFixed(0)}%</Text>
          <Text style={styles.metricLabel}>quality</Text>
        </View>
        <View style={styles.metricCell}>
          <Text style={styles.metricValue}>{metrics.sharpness.toFixed(1)}</Text>
          <Text style={styles.metricLabel}>sharpness</Text>
        </View>
        <View style={styles.metricCell}>
          <Text style={styles.metricValue}>{metrics.motion.toFixed(1)}</Text>
          <Text style={styles.metricLabel}>motion</Text>
        </View>
        <View style={styles.metricCell}>
          <Text style={styles.metricValue}>{metrics.droppedFrames}</Text>
          <Text style={styles.metricLabel}>dropped</Text>
        </View>
        <View style={styles.metricCell}>
          <Text style={styles.metricValue}>{metrics.detectionCount}</Text>
          <Text style={styles.metricLabel}>objects</Text>
        </View>
      </View>
    </View>
  );
}

export function SliceOneControlsPanel({
  bottomInset,
  classificationDownloadProgress,
  classificationError,
  classificationReady,
  completedItems,
  detectorDownloadProgress,
  detectorError,
  detectorReady,
  nextCameraAvailable,
  nextCameraPosition,
  onAnalysisTargetFpsChange,
  onDevProbe,
  onFlipCamera,
  onLayout,
  onNextItem,
  onShareTrace,
  onStart,
  onStop,
  selectedCaptures,
  soakTargetMs,
  state$,
  traceAvailable,
}: {
  bottomInset: number;
  classificationDownloadProgress: number;
  classificationError: boolean;
  classificationReady: boolean;
  completedItems: number;
  detectorDownloadProgress: number;
  detectorError: boolean;
  detectorReady: boolean;
  nextCameraAvailable: boolean;
  nextCameraPosition: CameraPosition;
  onAnalysisTargetFpsChange: (fps: AnalysisTargetFps) => void;
  onDevProbe: () => void;
  onFlipCamera: () => void;
  onLayout: (event: LayoutChangeEvent) => void;
  onNextItem: () => void;
  onShareTrace: () => void;
  onStart: () => void;
  onStop: () => void;
  selectedCaptures: number;
  soakTargetMs: number;
  state$: Observable<SliceOneViewState>;
  traceAvailable: boolean;
}) {
  const sessionState = useValue(state$.sessionState);
  const elapsedMs = useValue(state$.elapsedMs);
  const telemetry = useValue(state$.telemetry);
  const metrics = useValue(state$.metrics);
  const analysisTargetFps = useValue(state$.analysisTargetFps);
  const modelResult = useValue(state$.modelResult);
  const identificationStatus = useValue(state$.identificationStatus);
  const captureStatus = useValue(state$.captureStatus);
  const audioStats = useValue(state$.audioStats);
  const errorMessage = useValue(state$.errorMessage);
  const exportUri = useValue(state$.exportUri);
  const isCapturing = useValue(state$.isCapturing);
  const cameraPosition = useValue(state$.cameraPosition);
  const modelProbeRequested = useValue(state$.modelProbeRequested);
  const soakProgress = Math.min(1, elapsedMs / soakTargetMs);
  const cameraFlipDisabled =
    !nextCameraAvailable ||
    isCapturing ||
    sessionState === 'starting' ||
    sessionState === 'stopping';

  return (
    <View
      style={[styles.bottomPanel, { bottom: Math.max(10, bottomInset + 8) }]}
      onLayout={onLayout}>
      <View style={styles.soakHeader}>
        <View>
          <Text style={styles.soakTime}>
            {formatDuration(elapsedMs)} / {formatDuration(soakTargetMs)}
          </Text>
          <Text style={styles.soakLabel}>
            {elapsedMs >= soakTargetMs ? 'Soak target met' : 'Physical-device soak'}
          </Text>
        </View>
        <Text style={styles.telemetryText}>
          {telemetry?.thermalState ?? 'thermal n/a'} ·{' '}
          {formatBytes(telemetry?.residentMemoryBytes ?? 0)}
        </Text>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${soakProgress * 100}%` }]} />
      </View>

      <Text style={styles.detailText} numberOfLines={1}>
        Brightness {metrics.brightness.toFixed(0)} · clipped{' '}
        {(metrics.clippedRatio * 100).toFixed(0)}% · gate p95 {metrics.gateP95Ms.toFixed(1)} ms
      </Text>
      <Text style={styles.detailText} numberOfLines={1}>
        Selected {selectedCaptures}/3 · completed items {completedItems} · analysis{' '}
        {metrics.analysisFps.toFixed(1)}/{analysisTargetFps} fps
      </Text>
      <Text style={styles.detailText} numberOfLines={1}>
        Object {metrics.objectLabel} {(metrics.objectConfidence * 100).toFixed(0)}% ·{' '}
        {metrics.trackId}
      </Text>
      <Text style={styles.detailText} numberOfLines={2}>
        {modelResult}
      </Text>
      <Text style={styles.detailText} numberOfLines={2}>
        {identificationStatus}
      </Text>
      <Text style={styles.detailText} numberOfLines={1}>
        {captureStatus} · PCM chunks {audioStats?.chunkIndex ?? 0}
      </Text>
      {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
      {exportUri ? (
        <Text selectable style={styles.exportText} numberOfLines={2}>
          Trace: {exportUri}
        </Text>
      ) : null}

      <View style={styles.profileRow}>
        <Text style={styles.profileLabel}>ANALYSIS PROFILE</Text>
        {ANALYSIS_TARGET_FPS_OPTIONS.map((fps) => (
          <AnalysisProfileButton
            key={fps}
            disabled={sessionState !== 'idle'}
            fps={fps}
            selected={analysisTargetFps === fps}
            onPress={() => onAnalysisTargetFpsChange(fps)}
          />
        ))}
      </View>

      <View style={styles.cameraControlRow}>
        <View>
          <Text style={styles.cameraControlLabel}>CAMERA</Text>
          <Text style={styles.cameraControlValue}>{cameraPosition.toUpperCase()}</Text>
        </View>
        <Pressable
          accessibilityLabel={`Use ${nextCameraPosition} camera`}
          accessibilityRole="button"
          accessibilityState={{ disabled: cameraFlipDisabled }}
          disabled={cameraFlipDisabled}
          onPress={onFlipCamera}
          style={({ pressed }) => [
            styles.cameraFlipButton,
            pressed && !cameraFlipDisabled && styles.actionButtonPressed,
            cameraFlipDisabled && styles.actionButtonDisabled,
          ]}>
          <Text style={styles.cameraFlipButtonText}>Use {nextCameraPosition} camera</Text>
        </Pressable>
      </View>

      <View style={styles.controls}>
        {sessionState === 'idle' ? (
          <ActionButton label="Start" tone="primary" onPress={onStart} />
        ) : (
          <ActionButton
            label={sessionState === 'stopping' ? 'Stopping…' : 'Stop'}
            tone="danger"
            disabled={sessionState !== 'running'}
            onPress={onStop}
          />
        )}
        <ActionButton
          label="Next Item"
          disabled={sessionState !== 'running'}
          onPress={onNextItem}
        />
        <ActionButton
          label="Dev infer"
          disabled={sessionState !== 'running' || isCapturing}
          onPress={onDevProbe}
        />
        <ActionButton
          label="Share trace"
          disabled={!traceAvailable}
          onPress={onShareTrace}
        />
      </View>

      {!detectorReady && !detectorError ? (
        <View style={styles.modelLoading}>
          <ActivityIndicator color="#C9D5EA" size="small" />
          <Text style={styles.modelLoadingText}>
            Downloading object detector {(detectorDownloadProgress * 100).toFixed(0)}%
          </Text>
        </View>
      ) : modelProbeRequested && !classificationReady && !classificationError ? (
        <View style={styles.modelLoading}>
          <ActivityIndicator color="#C9D5EA" size="small" />
          <Text style={styles.modelLoadingText}>
            Downloading library model {(classificationDownloadProgress * 100).toFixed(0)}%
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  scanGuideLayer: {
    ...StyleSheet.absoluteFill,
    zIndex: 1,
  },
  topPanel: {
    position: 'absolute',
    top: 14,
    left: 14,
    right: 14,
    padding: 14,
    borderRadius: 22,
    backgroundColor: 'rgba(8, 12, 19, 0.82)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.18)',
    zIndex: 2,
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  eyebrow: {
    color: '#8FA2BF',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  heading: {
    color: '#F7FAFF',
    fontSize: 18,
    fontWeight: '700',
    marginTop: 3,
  },
  thumbnail: {
    width: 48,
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.35)',
  },
  gateRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 12,
  },
  gatePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 5,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  gatePillReady: {
    backgroundColor: 'rgba(52, 211, 153, 0.16)',
  },
  gatePillError: {
    backgroundColor: 'rgba(248, 113, 113, 0.18)',
  },
  gateDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#718096',
  },
  gateDotReady: {
    backgroundColor: '#6DF5A8',
  },
  gateDotError: {
    backgroundColor: '#FB7185',
  },
  gatePillText: {
    color: '#E5ECF7',
    fontSize: 10,
    fontWeight: '600',
  },
  metricsGrid: {
    flexDirection: 'row',
    marginTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255, 255, 255, 0.14)',
    paddingTop: 10,
  },
  metricCell: {
    flex: 1,
  },
  metricValue: {
    color: '#F7FAFF',
    fontSize: 16,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  metricLabel: {
    color: '#8FA2BF',
    fontSize: 9,
    marginTop: 1,
  },
  bottomPanel: {
    position: 'absolute',
    left: 14,
    right: 14,
    bottom: 10,
    padding: 14,
    borderRadius: 22,
    backgroundColor: 'rgba(8, 12, 19, 0.9)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.18)',
    zIndex: 2,
  },
  soakHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 12,
  },
  soakTime: {
    color: '#F7FAFF',
    fontSize: 18,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  soakLabel: {
    color: '#8FA2BF',
    fontSize: 10,
    marginTop: 1,
  },
  telemetryText: {
    color: '#B7C5DA',
    fontSize: 10,
    textTransform: 'capitalize',
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    marginVertical: 10,
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
    backgroundColor: '#6DF5A8',
  },
  detailText: {
    color: '#B7C5DA',
    fontSize: 10,
    lineHeight: 15,
  },
  errorText: {
    color: '#FDA4AF',
    fontSize: 10,
    lineHeight: 15,
    marginTop: 4,
  },
  exportText: {
    color: '#93C5FD',
    fontSize: 9,
    lineHeight: 13,
    marginTop: 4,
  },
  controls: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
  },
  profileLabel: {
    flex: 1,
    color: '#8FA2BF',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  profileButton: {
    minWidth: 48,
    minHeight: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.18)',
    backgroundColor: 'rgba(255, 255, 255, 0.07)',
  },
  profileButtonSelected: {
    borderColor: '#6DF5A8',
    backgroundColor: 'rgba(52, 211, 153, 0.18)',
  },
  profileButtonText: {
    color: '#AAB6C9',
    fontSize: 10,
    fontWeight: '700',
  },
  profileButtonTextSelected: {
    color: '#D9FFEA',
  },
  cameraControlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 10,
  },
  cameraControlLabel: {
    color: '#8FA2BF',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  cameraControlValue: {
    color: '#F7FAFF',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 1,
  },
  cameraFlipButton: {
    minHeight: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingHorizontal: 14,
    backgroundColor: '#243047',
  },
  cameraFlipButtonText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  actionButton: {
    flex: 1,
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    paddingHorizontal: 8,
    backgroundColor: '#243047',
  },
  actionButtonPrimary: {
    backgroundColor: '#0F9F67',
  },
  actionButtonDanger: {
    backgroundColor: '#B73A4A',
  },
  actionButtonPressed: {
    opacity: 0.74,
  },
  actionButtonDisabled: {
    opacity: 0.38,
  },
  actionButtonText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },
  modelLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    marginTop: 9,
  },
  modelLoadingText: {
    color: '#C9D5EA',
    fontSize: 10,
  },
});
