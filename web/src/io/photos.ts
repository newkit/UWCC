// Saving results to the photo library on iPhone and iPad.
//
// A web app cannot write to Photos directly. The share sheet can: given a
// JPEG or an MP4 it offers "Save Image" / "Save Video". Where that works,
// results are handed to the share sheet instead of being downloaded (a
// download on iOS ends up in the Files app, not in Photos).
//
// The share sheet only opens in response to a tap. After a photo is
// exported the tap may have expired; then the user is offered a button.

/** iPhone or iPad, including iPads that report themselves as a Mac. */
const isIos = () =>
  typeof navigator !== 'undefined' &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

function canShareFiles(): boolean {
  try {
    return !!navigator.canShare?.({ files: [new File([new Uint8Array(1)], 'test.jpg', { type: 'image/jpeg' })] });
  } catch {
    return false;
  }
}

/** True when results go to the photo library through the share sheet. */
export const photoLibrary: boolean = isIos() && canShareFiles();

export type ShareOutcome = 'shared' | 'cancelled' | 'needs-tap' | 'failed';

/** Open the share sheet for the given files. */
export async function shareToPhotos(files: File[]): Promise<ShareOutcome> {
  try {
    await navigator.share({ files });
    return 'shared';
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'AbortError') return 'cancelled';
    if (name === 'NotAllowedError') return 'needs-tap';
    return 'failed';
  }
}
