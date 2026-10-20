import { AppError } from "@/lib/errors";

// The playground's ceiling for an uploaded voice note. The SDK's is smaller (sdk.controller.ts).
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// Size + type validation and mime normalization for an uploaded voice note, shared by the
// playground's transcribe-only step, its full audio turn and the SDK's transcription.
export async function normalizeAudioUpload(
  file: File,
  maxBytes = MAX_AUDIO_BYTES,
): Promise<{ bytes: ArrayBuffer; mimeType: string | null }> {
  if (file.size > maxBytes) {
    throw new AppError("audio too large", 413, "errors.audioTooLarge");
  }
  // Bun derives a multipart File's content-type from the filename extension, not the
  // browser-set `type`. MediaRecorder voice notes are `.webm`, which maps to `video/webm` (webm
  // is a video-container MIME even when it carries only an audio track), so an audio-only
  // recording legitimately arrives as `video/webm`. Accept it alongside `audio/*`, then normalize
  // it so the downstream STT request advertises an audio mime.
  const rawType = file.type || null;
  const isAudioLike =
    !rawType || rawType.startsWith("audio/") || rawType === "video/webm";
  if (!isAudioLike) {
    throw new AppError(
      "unsupported audio type",
      415,
      "errors.unsupportedAudioType",
    );
  }
  const mimeType = rawType === "video/webm" ? "audio/webm" : rawType;
  return { bytes: await file.arrayBuffer(), mimeType };
}
