export const MAX_SELECTION_IMAGE_REFERENCES = 64;
export const MAX_SELECTION_IMAGE_FETCHES = 8;

export interface SelectionImagePlan {
  readonly references: readonly string[];
  readonly fetchReferences: readonly string[];
  readonly selectedImageCount: number;
  readonly referenceCount: number;
  readonly missingReferenceCount: number;
  readonly omittedReferenceCount: number;
  readonly skippedFetchCount: number;
  readonly isPartial: boolean;
}

export function planSelectionImages(input: {
  readonly imageRefs: readonly string[];
  readonly selectedImageCount?: number;
  readonly omittedReferenceCount?: number;
}): SelectionImagePlan {
  const references = input.imageRefs.slice(0, MAX_SELECTION_IMAGE_REFERENCES);
  const selectedImageCount = Math.max(input.selectedImageCount ?? references.length, references.length);
  const reportedOmitted = Math.max(0, input.omittedReferenceCount ?? 0);
  const omittedReferenceCount = reportedOmitted + Math.max(0, input.imageRefs.length - references.length);
  const missingReferenceCount = Math.max(
    0,
    selectedImageCount - references.length - omittedReferenceCount,
  );
  const fetchReferences = references.slice(0, MAX_SELECTION_IMAGE_FETCHES);
  const skippedFetchCount = Math.max(0, references.length - fetchReferences.length)
    + omittedReferenceCount
    + missingReferenceCount;
  return {
    references,
    fetchReferences,
    selectedImageCount,
    referenceCount: references.length,
    missingReferenceCount,
    omittedReferenceCount,
    skippedFetchCount,
    isPartial: skippedFetchCount > 0,
  };
}
