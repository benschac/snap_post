import type { Observable } from '@legendapp/state';
import { useValue } from '@legendapp/state/react';
import { useFocusEffect } from 'expo-router';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { Platform } from 'react-native';
import {
  type CameraObjectOutput,
  type InterruptionReason,
  type ScannedObject,
  type ScannedObjectType,
  VisionCamera,
  useCameraDevice,
  useCameraPermission,
  usePhotoOutput,
} from 'react-native-vision-camera';

import SnapNative from '../../../modules/snap-native/src/SnapNativeModule';
import {
  beginCameraSwitch,
  markCameraSwitchConfigured,
  shouldCompleteCameraSwitch,
  type CameraSwitchState,
} from '../slice-one/camera-switch-lifecycle';
import type {
  CameraPosition,
  SliceOneViewState,
} from './slice-one-view-state';
import type { SliceTrace } from './trace';

const PHOTO_PREVIEW_SIZE = { width: 320, height: 320 };
const IDENTIFICATION_PHOTO_SIZE = { width: 1024, height: 768 };
export const SALIENT_OBJECT_TYPE: ScannedObjectType = 'salient-object';
const SALIENT_OBJECT_TYPES: ScannedObjectType[] = [SALIENT_OBJECT_TYPE];

type UseSliceOneCameraOptions = {
  captureInFlightRef: RefObject<boolean>;
  getCurrentItemIndex: () => number;
  onCameraTrackingReset: () => void;
  onSalientObjectsScanned: (objects: ScannedObject[]) => void;
  state$: Observable<SliceOneViewState>;
  traceRef: RefObject<SliceTrace | null>;
};

export function useSliceOneCamera({
  captureInFlightRef,
  getCurrentItemIndex,
  onCameraTrackingReset,
  onSalientObjectsScanned,
  state$,
  traceRef,
}: UseSliceOneCameraOptions) {
  const [isFocused, setIsFocused] = useState(false);
  const cameraPosition = useValue(state$.cameraPosition);
  const sessionState = useValue(state$.sessionState);
  const cameraPermission = useCameraPermission();
  const backCameraDevice = useCameraDevice('back', { physicalDevices: ['wide-angle'] });
  const frontCameraDevice = useCameraDevice('front');
  const cameraDevice = cameraPosition === 'front' ? frontCameraDevice : backCameraDevice;
  const photoOutput = usePhotoOutput({
    containerFormat: 'jpeg',
    qualityPrioritization: 'balanced',
    targetResolution: IDENTIFICATION_PHOTO_SIZE,
    previewImageTargetSize: PHOTO_PREVIEW_SIZE,
  });
  const salientObjectOutput = useMemo<CameraObjectOutput | null>(
    () =>
      Platform.OS === 'ios'
        ? VisionCamera.createObjectOutput({ enabledObjectTypes: SALIENT_OBJECT_TYPES })
        : null,
    []
  );
  const firstPreviewSeenRef = useRef(false);
  const cameraSwitchRef = useRef<CameraSwitchState<CameraPosition> | null>(null);

  useEffect(() => {
    if (!salientObjectOutput) return;
    salientObjectOutput.setOnObjectsScannedCallback(onSalientObjectsScanned);
    return () => salientObjectOutput.setOnObjectsScannedCallback(undefined);
  }, [onSalientObjectsScanned, salientObjectOutput]);

  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => setIsFocused(false);
    }, [])
  );

  const completeCameraSwitch = useCallback(
    (signal: 'analysis-frame' | 'preview-started', deviceId: string) => {
      const pendingSwitch = cameraSwitchRef.current;
      if (!pendingSwitch || pendingSwitch.targetDeviceId !== deviceId) return false;

      cameraSwitchRef.current = null;
      onCameraTrackingReset();
      state$.cameraConfigured.set(true);
      state$.cameraPreviewStarted.set(true);
      state$.qualityGateStatus.set('Waiting for a stable view');
      traceRef.current?.mark('camera.flip_completed', {
        cameraPosition: pendingSwitch.targetPosition,
        cameraDeviceId: pendingSwitch.targetDeviceId,
        completionSignal: signal,
        itemIndex: getCurrentItemIndex(),
        latencyMs: performance.now() - pendingSwitch.requestedAtMs,
      });
      return true;
    },
    [getCurrentItemIndex, onCameraTrackingReset, state$, traceRef]
  );

  const flipCamera = useCallback(() => {
    if (
      sessionState === 'starting' ||
      sessionState === 'stopping' ||
      state$.isCapturing.peek() ||
      captureInFlightRef.current
    ) {
      return;
    }
    const nextPosition: CameraPosition = cameraPosition === 'back' ? 'front' : 'back';
    const nextDevice = nextPosition === 'front' ? frontCameraDevice : backCameraDevice;
    if (!nextDevice) return;

    const isLiveSwitch = sessionState === 'running';
    if (isLiveSwitch) {
      traceRef.current?.mark('camera.flip_requested', {
        from: cameraPosition,
        to: nextPosition,
        itemIndex: getCurrentItemIndex(),
        targetDeviceId: nextDevice.id,
      });
    }
    cameraSwitchRef.current = isLiveSwitch
      ? beginCameraSwitch(nextDevice.id, nextPosition, performance.now())
      : null;
    state$.cameraConfigured.set(false);
    state$.cameraPreviewStarted.set(false);
    onCameraTrackingReset();
    if (isLiveSwitch) state$.qualityGateStatus.set('Switching camera');
    state$.cameraPosition.set(nextPosition);
  }, [
    backCameraDevice,
    cameraPosition,
    captureInFlightRef,
    frontCameraDevice,
    getCurrentItemIndex,
    onCameraTrackingReset,
    sessionState,
    state$,
    traceRef,
  ]);

  const handleAnalysisFrame = useCallback(
    (frameProcessingStartedAtMs: number) => {
      const pendingSwitch = cameraSwitchRef.current;
      if (
        !shouldCompleteCameraSwitch(pendingSwitch, frameProcessingStartedAtMs) ||
        !pendingSwitch
      ) {
        return false;
      }
      return completeCameraSwitch('analysis-frame', pendingSwitch.targetDeviceId);
    },
    [completeCameraSwitch]
  );

  const isSwitching = useCallback(() => cameraSwitchRef.current !== null, []);

  const resetForSession = useCallback(() => {
    cameraSwitchRef.current = null;
    firstPreviewSeenRef.current = false;
    state$.cameraPreviewStarted.set(false);
  }, [state$]);

  const onConfigured = useCallback(() => {
    if (!cameraDevice) return;
    cameraSwitchRef.current = markCameraSwitchConfigured(
      cameraSwitchRef.current,
      cameraDevice.id,
      performance.now()
    );
    state$.cameraConfigured.set(true);
    if (state$.sessionState.peek() === 'running') {
      traceRef.current?.mark('camera.configured', {
        cameraPosition: state$.cameraPosition.peek(),
        cameraDeviceId: cameraDevice.id,
      });
    }
  }, [cameraDevice, state$, traceRef]);

  const onPreviewStarted = useCallback(() => {
    if (!cameraDevice) return;
    const completedSwitch = completeCameraSwitch('preview-started', cameraDevice.id);
    state$.cameraPreviewStarted.set(true);
    if (state$.sessionState.peek() === 'running') {
      traceRef.current?.mark('camera.preview_started', {
        cameraPosition: state$.cameraPosition.peek(),
        cameraDeviceId: cameraDevice.id,
        afterFlip: completedSwitch,
      });
    }
    if (!firstPreviewSeenRef.current) {
      firstPreviewSeenRef.current = true;
      traceRef.current?.mark('camera.first_preview_frame', {
        cameraPosition: state$.cameraPosition.peek(),
        cameraDeviceId: cameraDevice.id,
      });
      SnapNative?.mark('camera.first_preview_frame');
    }
  }, [cameraDevice, completeCameraSwitch, state$, traceRef]);

  const onError = useCallback(
    (error: Error) => {
      state$.errorMessage.set(`Camera: ${error.message}`);
      if (state$.sessionState.peek() === 'running') {
        traceRef.current?.mark('camera.error', {
          message: error.message,
          cameraPosition: state$.cameraPosition.peek(),
        });
      }
    },
    [state$, traceRef]
  );

  const onInterruptionStarted = useCallback(
    (reason: InterruptionReason) =>
      traceRef.current?.mark('camera.interruption_started', { reason }),
    [traceRef]
  );
  const onInterruptionEnded = useCallback(
    () => traceRef.current?.mark('camera.interruption_ended'),
    [traceRef]
  );
  const nextCameraPosition: CameraPosition = cameraPosition === 'back' ? 'front' : 'back';
  const nextCameraAvailable =
    nextCameraPosition === 'front'
      ? frontCameraDevice !== undefined
      : backCameraDevice !== undefined;

  return {
    cameraDevice,
    cameraPermission,
    cameraPosition,
    flipCamera,
    handleAnalysisFrame,
    isActive: sessionState === 'running' && isFocused && cameraPermission.hasPermission,
    isSwitching,
    nextCameraAvailable,
    nextCameraPosition,
    onConfigured,
    onError,
    onInterruptionEnded,
    onInterruptionStarted,
    onPreviewStarted,
    photoOutput,
    resetForSession,
    salientObjectOutput,
  };
}
