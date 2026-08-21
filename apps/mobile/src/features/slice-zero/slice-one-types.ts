import type { Image } from 'react-native-nitro-image';

import type { SelectedCapture } from '../slice-one/capture-policy';
import type { CaptureItem } from '../slice-one/item-session';

export type RetainedCapture = SelectedCapture & {
  fileUri: string;
  previewImage?: Image;
  previewUri?: string;
};

export type SessionItem = CaptureItem<RetainedCapture>;

export type CaptureGateOutcome =
  | 'busy'
  | 'capture'
  | 'cooldown'
  | 'duplicate'
  | 'no-object'
  | 'quality'
  | 'stabilizing';

export type LabelAgnosticShadowCounters = {
  acceptedFrames: number;
  filteredDetectionFrames: number;
  personDetectionFrames: number;
  recoveredTrackFrames: number;
  trackedFrames: number;
  wouldCapture: number;
};

export type SalientObjectShadowCounters = {
  callbackCount: number;
  freshFrames: number;
  missingFrames: number;
  objectCount: number;
  recoveredTrackFrames: number;
  staleFrames: number;
  trackedFrames: number;
  wouldCapture: number;
};
