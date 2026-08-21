import type { IdentifyResponse } from '@snap/protocol';

export function formatIdentityCandidate(candidate: IdentifyResponse['candidate']) {
  const parts = [
    candidate.brand,
    candidate.productName,
    candidate.model,
    candidate.variant,
  ];
  const uniqueParts = parts.filter(
    (part, index): part is string =>
      Boolean(part) &&
      parts.findIndex(
        (candidatePart) =>
          candidatePart?.toLocaleLowerCase() === part?.toLocaleLowerCase()
      ) === index
  );
  return uniqueParts.length > 0 ? uniqueParts.join(' ') : candidate.category;
}
