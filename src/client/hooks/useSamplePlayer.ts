import { useSyncExternalStore } from "react";

// One <audio> element for the whole console, so a second sample stops the first wherever it was
// started (two voice pickers on the same page included). The state is the URL now playing, or null,
// and the picker that started it.

let audio: HTMLAudioElement | null = null;
let playing: string | null = null;
// Who started the sample playing now: two pickers can play the same URL, so the URL alone cannot say
// whose it is.
let owner: symbol | null = null;
// Bumped on every start, so the rejection of a play() that a later toggle replaced is ignored.
let attempt = 0;
const listeners = new Set<() => void>();

function setPlaying(url: string | null, by: symbol | null = owner) {
  if (playing === url && owner === by) return;
  playing = url;
  owner = by;
  for (const notify of listeners) notify();
}

function element(): HTMLAudioElement {
  if (audio) return audio;
  const el = new Audio();
  el.preload = "none";
  // A sample that ends, fails to load (404, unsupported codec) or is refused by autoplay policy puts
  // the control back to "play", so it never stays stuck showing a sample that is not playing.
  el.addEventListener("ended", () => setPlaying(null));
  el.addEventListener("error", () => setPlaying(null));
  audio = el;
  return el;
}

function stopSample() {
  attempt++;
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  setPlaying(null, null);
}

// Plays `url` for `by`, or stops it when `by` is the one already playing it. The same URL started by
// another picker plays again under `by`, so the control pressed is the one that shows Stop.
function toggle(url: string, by: symbol) {
  if (playing === url && owner === by) {
    stopSample();
    return;
  }
  const el = element();
  el.pause();
  el.src = url;
  setPlaying(url, by);
  const mine = ++attempt;
  el.play().catch(() => {
    if (mine === attempt) setPlaying(null);
  });
}

// Stops the sample playing now only when `by` started it, and it is not `unless`. Read outside React,
// so a cleanup acts on what is playing now and not on a stale render.
export function stopSampleOf(by: symbol, unless?: string): void {
  if (owner === by && playing !== null && playing !== unless) stopSample();
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

// What `by` hears: the URL it started and is still playing, or null when nothing or another picker's
// sample is playing.
export function useSamplePlayer(by: symbol) {
  const current = useSyncExternalStore(
    subscribe,
    () => (owner === by ? playing : null),
    () => null,
  );
  return { playing: current, toggle: (url: string) => toggle(url, by) };
}
