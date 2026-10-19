// Where ElevenLabs serves the audio samples it lists (a voice's `preview_url`, its per-language
// previews): its own API hosts and one public storage bucket. The console plays them straight from
// there, so the page's CSP allows these sources for media, and the voice listing drops a sample
// hosted anywhere else, which the browser would refuse to load.
export const ELEVENLABS_MEDIA_SOURCES = [
  "https://*.elevenlabs.io",
  "https://storage.googleapis.com/eleven-public-prod/",
];

export function isElevenLabsMediaUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "") return false;
  if (url.hostname.endsWith(".elevenlabs.io")) return true;
  return (
    url.hostname === "storage.googleapis.com" &&
    url.pathname.startsWith("/eleven-public-prod/")
  );
}
