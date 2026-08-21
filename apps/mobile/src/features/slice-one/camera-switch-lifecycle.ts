export type CameraSwitchState<Position extends string = string> = {
  configuredAtMs: number | null;
  requestedAtMs: number;
  targetDeviceId: string;
  targetPosition: Position;
};

export function beginCameraSwitch<Position extends string>(
  targetDeviceId: string,
  targetPosition: Position,
  requestedAtMs: number
): CameraSwitchState<Position> {
  return {
    configuredAtMs: null,
    requestedAtMs,
    targetDeviceId,
    targetPosition,
  };
}

export function markCameraSwitchConfigured<Position extends string>(
  state: CameraSwitchState<Position> | null,
  deviceId: string,
  configuredAtMs: number
): CameraSwitchState<Position> | null {
  if (!state || state.targetDeviceId !== deviceId || !Number.isFinite(configuredAtMs)) {
    return state;
  }

  return { ...state, configuredAtMs };
}

export function shouldCompleteCameraSwitch(
  state: CameraSwitchState | null,
  frameProcessingStartedAtMs: number
) {
  if (!state || state.configuredAtMs === null) return false;

  return (
    Number.isFinite(frameProcessingStartedAtMs) &&
    frameProcessingStartedAtMs >= state.configuredAtMs
  );
}
