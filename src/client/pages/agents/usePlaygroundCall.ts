// A call to the agent from the playground: the browser's microphone in place of the WhatsApp line.
// It speaks the frames the whatsapp-connector speaks on a real call (`start`, `answered`, `media`
// with base64 PCM at 16 kHz mono, `stop`), and plays what comes back (`media`, `clear` when the
// person talks over the agent, `hangup` with who ended it), plus the `ready`, `transcript` and `tool`
// frames only this route sends. The line sounds like a phone: ringback while the engine connects,
// the busy tone when the call ends.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/client/lib/api";

const RATE = 16_000;
// The microphone's frame at the device's rate: 21 ms at 48 kHz, 23 ms at 44.1 kHz, inside the 20 to
// 60 ms a call sends.
const FRAME = 1024;
// The Brazilian line tones: 425 Hz, ringback 1 s on and 4 s off, busy 250 ms on and off.
const TONE_HZ = 425;
// How often the meters on the screen are refreshed.
const METER_MS = 100;
// What the agent's audio carries besides its voice: the background sound plays the whole call, so
// "audio is queued" is not "the agent is talking". Measured on a call with the background on, 100 ms
// windows: the background between 0.009 and 0.016 RMS, the voice above 0.05.
const SPEECH_RMS = 0.035;
const SPEECH_WINDOW = 800; // 50 ms at 16 kHz
// Kept on through the pauses between words, so the line does not flicker mid-sentence.
const SPEECH_HANGOVER_S = 0.3;
// The loudest microphone sample of a refresh that counts as the operator talking.
const MIC_SPEECH_PEAK = 0.08;

/**
 * When the voice in a chunk of the agent's audio ends, on the audio clock, the chunk starting at
 * `at`; null for a chunk with no voice in it (the background alone, or silence).
 */
export function voiceEndIn(samples: Float32Array, at: number): number | null {
  let end: number | null = null;
  for (let i = 0; i < samples.length; i += SPEECH_WINDOW) {
    const stop = Math.min(samples.length, i + SPEECH_WINDOW);
    let sum = 0;
    for (let j = i; j < stop; j++) sum += (samples[j] as number) ** 2;
    if (Math.sqrt(sum / (stop - i)) > SPEECH_RMS) end = at + stop / RATE;
  }
  return end;
}

/**
 * The microphone at the audio context's rate brought down to the call's 16 kHz, frame after frame:
 * each sample the mean of the input it spans, what is left of a frame carried into the next one.
 */
export function downsampler(
  fromRate: number,
): (input: Float32Array) => Float32Array {
  const step = fromRate / RATE;
  let carry = new Float32Array(0);
  // Where the next sample starts, in `carry` followed by the new frame.
  let pos = 0;
  return (input) => {
    const buf = new Float32Array(carry.length + input.length);
    buf.set(carry);
    buf.set(input, carry.length);
    const out: number[] = [];
    while (pos + step <= buf.length) {
      const from = Math.floor(pos);
      const to = Math.max(from + 1, Math.floor(pos + step));
      let sum = 0;
      for (let i = from; i < to; i++) sum += buf[i] as number;
      out.push(sum / (to - from));
      pos += step;
    }
    const kept = Math.floor(pos);
    carry = buf.slice(kept);
    pos -= kept;
    return Float32Array.from(out);
  };
}

/** Who the screen says is talking: the agent while its voice plays, the operator while the microphone hears them. */
export function speakerNow(
  voiceUntil: number,
  now: number,
  micPeak: number,
): "agent" | "operator" | null {
  if (now < voiceUntil + SPEECH_HANGOVER_S) return "agent";
  return micPeak > MIC_SPEECH_PEAK ? "operator" : null;
}

export type CallEnd =
  | { by: "agent"; reason: string | null }
  | { by: "error"; reason: string | null }
  | { by: "operator" }
  | { by: "dropped" };

export type CallState =
  | { state: "idle" }
  | { state: "preparing" }
  | { state: "ringing" }
  | { state: "live"; since: number }
  | { state: "ended"; end: CallEnd; durationSecs: number | null }
  | { state: "failed"; problem: string; detail: string | null };

export type CallLine =
  | { role: "user" | "agent"; text: string }
  // A tool the agent ran; `simulated` when the playground stood in for Chatwoot.
  | { role: "tool"; name: string; ok: boolean; simulated: boolean };

export interface CallMeters {
  // 0 to 1, the loudest sample since the last refresh.
  mic: number;
  speaker: "agent" | "operator" | null;
}

function toBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64: string): Float32Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Float32Array(bin.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const u = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    out[i] = (u >= 0x8000 ? u - 0x10000 : u) / 0x8000;
  }
  return out;
}

/** Plays the line tone in bursts of `onSecs` every `periodSecs`, `count` times; returns how to stop it. */
function tone(
  audio: AudioContext,
  onSecs: number,
  periodSecs: number,
  count: number,
): () => void {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = TONE_HZ;
  gain.gain.value = 0;
  const t0 = audio.currentTime + 0.05;
  for (let i = 0; i < count; i++) {
    const at = t0 + i * periodSecs;
    gain.gain.setValueAtTime(0.12, at);
    gain.gain.setValueAtTime(0, at + onSecs);
  }
  osc.connect(gain).connect(audio.destination);
  osc.start(t0);
  osc.stop(t0 + count * periodSecs);
  return () => gain.disconnect();
}

interface Live {
  ws: WebSocket;
  audio: AudioContext;
  mic: MediaStream;
  node: ScriptProcessorNode;
  playing: Set<AudioBufferSourceNode>;
  next: number;
  // When the agent's voice (not its background) stops playing, on the audio clock.
  voiceUntil: number;
  micPeak: number;
  stopRingback: (() => void) | null;
  answeredAt: number | null;
}

function play(l: Live, b64: string) {
  const samples = fromBase64(b64);
  if (samples.length === 0) return;
  const buffer = l.audio.createBuffer(1, samples.length, RATE);
  buffer.copyToChannel(samples, 0);
  const source = l.audio.createBufferSource();
  source.buffer = buffer;
  source.connect(l.audio.destination);
  const at = Math.max(l.next, l.audio.currentTime);
  source.start(at);
  l.next = at + buffer.duration;
  const voiceEnd = voiceEndIn(samples, at);
  if (voiceEnd !== null) l.voiceUntil = Math.max(l.voiceUntil, voiceEnd);
  l.playing.add(source);
  source.onended = () => l.playing.delete(source);
}

function clear(l: Live) {
  for (const source of l.playing) source.stop();
  l.playing.clear();
  l.next = l.audio.currentTime;
  l.voiceUntil = l.audio.currentTime;
}

export function usePlaygroundCall(agentId: string) {
  const [call, setCall] = useState<CallState>({ state: "idle" });
  const [lines, setLines] = useState<CallLine[]>([]);
  const [meters, setMeters] = useState<CallMeters>({
    mic: 0,
    speaker: null,
  });
  const live = useRef<Live | null>(null);
  // Bumped when the screen goes away: a start still waiting on the setup or the microphone prompt
  // sees it changed and stops there, releasing a microphone granted too late.
  const attempt = useRef(0);
  // A microphone granted while the ticket is still being asked for: no line holds it yet, so leaving
  // the screen releases it from here instead of waiting for the request to come back.
  const pendingMic = useRef<MediaStream | null>(null);
  // The same for the audio context made on the click, before any line holds it.
  const pendingAudio = useRef<AudioContext | null>(null);

  // Releases the microphone and the socket at once; the audio context lingers for `afterSecs`, so the
  // end of the farewell and the busy tone are still heard.
  const release = useCallback((afterSecs: number) => {
    const l = live.current;
    live.current = null;
    if (!l) return null;
    l.stopRingback?.();
    l.node.onaudioprocess = null;
    l.node.disconnect();
    for (const track of l.mic.getTracks()) track.stop();
    l.ws.onclose = null;
    if (l.ws.readyState <= WebSocket.OPEN) l.ws.close();
    setTimeout(() => void l.audio.close(), afterSecs * 1000);
    return l;
  }, []);

  useEffect(
    () => () => {
      attempt.current++;
      for (const track of pendingMic.current?.getTracks() ?? []) track.stop();
      pendingMic.current = null;
      void pendingAudio.current?.close().catch(() => {});
      pendingAudio.current = null;
      release(0);
    },
    [release],
  );

  // The meters, refreshed while the line is up.
  const up = call.state === "ringing" || call.state === "live";
  useEffect(() => {
    if (!up) {
      setMeters({ mic: 0, speaker: null });
      return;
    }
    const timer = setInterval(() => {
      const l = live.current;
      if (!l) return;
      setMeters({
        mic: l.micPeak,
        speaker: speakerNow(l.voiceUntil, l.audio.currentTime, l.micPeak),
      });
      l.micPeak = 0;
    }, METER_MS);
    return () => clearInterval(timer);
  }, [up]);

  const end = useCallback(
    (how: CallEnd) => {
      const l = live.current;
      if (!l) return;
      if (how.by === "operator") clear(l);
      // What is still queued of the agent's speech plays out, then the busy tone.
      const left = Math.max(0, l.next - l.audio.currentTime);
      const durationSecs = l.answeredAt
        ? Math.round((Date.now() - l.answeredAt) / 1000)
        : null;
      release(left + 1.8);
      setTimeout(() => {
        if (l.audio.state !== "closed") tone(l.audio, 0.25, 0.5, 3);
      }, left * 1000);
      setCall({ state: "ended", end: how, durationSecs });
    },
    [release],
  );

  // `before` runs after the click has made the audio context and before the microphone is asked for:
  // a save that has to land first happens inside this attempt, so leaving the screen or cancelling
  // while it runs stops the call here, and the context was still made in the gesture.
  const start = useCallback(
    async (before?: () => Promise<boolean>) => {
      if (live.current) return;
      const mine = ++attempt.current;
      setLines([]);
      setCall({ state: "preparing" });
      // Made and resumed in the click itself: Safari starts Web Audio only inside a user gesture, and the
      // microphone prompt and the setup request below both end it. The context runs at the device's
      // rate: Firefox refuses a microphone into a context at another rate (`NotSupportedError`), so the
      // microphone is brought to the call's 16 kHz here, and the agent's buffers by the browser.
      const audio = new AudioContext();
      pendingAudio.current = audio;
      const unlocked = audio.resume().catch(() => {});
      // Closed once: leaving the screen or cancelling may have closed it already, and a second close
      // rejects. The ref is cleared only while it still holds this attempt's context: a stale attempt
      // finishing late must not let go of the one a newer call is holding.
      const dropAudio = () => {
        if (pendingAudio.current === audio) pendingAudio.current = null;
        void audio.close().catch(() => {});
      };
      if (before) {
        const saved = await before();
        if (attempt.current !== mine) {
          dropAudio();
          return;
        }
        if (!saved) {
          dropAudio();
          setCall({ state: "idle" });
          return;
        }
      }
      let mic: MediaStream;
      try {
        mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch (err) {
        dropAudio();
        if (attempt.current !== mine) return;
        setCall({
          state: "failed",
          problem: "microphone",
          detail: (err as Error).message,
        });
        return;
      }
      const dropMic = () => {
        if (pendingMic.current === mic) pendingMic.current = null;
        for (const track of mic.getTracks()) track.stop();
        dropAudio();
      };
      if (attempt.current !== mine) {
        dropMic();
        return;
      }
      // The ticket after the microphone: it lasts a minute, and the browser's prompt can take longer.
      pendingMic.current = mic;
      // A body that cannot be read rejects instead of answering `error`: the same failure.
      const { data, error } = await api.api.v1
        .agents({ id: agentId })
        .playground.call.post()
        .catch((err: unknown) => ({ data: null, error: err }));
      if (attempt.current !== mine) {
        dropMic();
        return;
      }
      if (error || !data) {
        dropMic();
        setCall({ state: "failed", problem: "unreachable", detail: null });
        return;
      }
      if (!data.ok) {
        dropMic();
        setCall({
          state: "failed",
          problem: String(data.problem),
          detail: data.detail ?? null,
        });
        return;
      }
      // A context the browser kept suspended would show a live call nobody hears and nothing is sent on.
      await unlocked;
      if (attempt.current !== mine) {
        dropMic();
        return;
      }
      if (audio.state !== "running") {
        dropMic();
        setCall({ state: "failed", problem: "audio", detail: null });
        return;
      }
      // A browser that cannot build the audio graph fails the call here, with nothing left holding the
      // microphone, instead of ringing with no line behind it.
      let node: ScriptProcessorNode;
      try {
        node = audio.createScriptProcessor(FRAME, 1, 1);
        audio.createMediaStreamSource(mic).connect(node);
        // A ScriptProcessorNode only runs while connected; its output stays silent.
        node.connect(audio.destination);
      } catch (err) {
        dropMic();
        setCall({
          state: "failed",
          problem: "audio",
          detail: (err as Error).message,
        });
        return;
      }
      pendingAudio.current = null;
      const toCallRate = downsampler(audio.sampleRate);
      const scheme = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(
        `${scheme}//${location.host}/api/v1/voice/playground/${encodeURIComponent(data.ticket)}`,
      );
      const l: Live = {
        ws,
        audio,
        mic,
        node,
        playing: new Set(),
        next: 0,
        voiceUntil: 0,
        micPeak: 0,
        stopRingback: tone(audio, 1, 5, 12),
        answeredAt: null,
      };
      pendingMic.current = null;
      live.current = l;
      setCall({ state: "ringing" });

      node.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        let peak = 0;
        for (const s of input) peak = Math.max(peak, Math.abs(s));
        l.micPeak = Math.max(l.micPeak, peak);
        const samples = toCallRate(input);
        if (ws.readyState !== WebSocket.OPEN || !l.answeredAt) return;
        const pcm = Int16Array.from(samples, (s) =>
          Math.max(-0x8000, Math.min(0x7fff, Math.round(s * 0x8000))),
        );
        ws.send(JSON.stringify({ event: "media", payload: toBase64(pcm) }));
      };

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            event: "start",
            direction: "inbound",
            call_id: crypto.randomUUID(),
          }),
        );
        ws.send(JSON.stringify({ event: "answered" }));
      };
      ws.onmessage = (msg) => {
        let frame: {
          event?: string;
          payload?: string;
          role?: string;
          text?: string;
          name?: string;
          ok?: boolean;
          simulated?: boolean;
          by?: string;
          reason?: string | null;
        };
        try {
          frame = JSON.parse(String(msg.data));
        } catch {
          return;
        }
        switch (frame.event) {
          case "ready":
            l.stopRingback?.();
            l.stopRingback = null;
            l.answeredAt = Date.now();
            setCall({ state: "live", since: l.answeredAt });
            break;
          case "media":
            if (frame.payload) play(l, frame.payload);
            break;
          case "clear":
            clear(l);
            break;
          case "transcript":
            if (frame.text) {
              const line: CallLine = {
                role: frame.role === "agent" ? "agent" : "user",
                text: frame.text,
              };
              setLines((prev) => [...prev, line]);
            }
            break;
          case "tool":
            if (frame.name) {
              const line: CallLine = {
                role: "tool",
                name: frame.name,
                ok: frame.ok !== false,
                simulated: frame.simulated === true,
              };
              setLines((prev) => [...prev, line]);
            }
            break;
          case "hangup":
            end({
              by: frame.by === "error" ? "error" : "agent",
              reason: frame.reason ?? null,
            });
            break;
        }
      };
      ws.onclose = () => end({ by: "dropped" });
    },
    [agentId, end],
  );

  const hangUp = useCallback(() => {
    const l = live.current;
    if (l?.ws.readyState === WebSocket.OPEN)
      l.ws.send(JSON.stringify({ event: "stop" }));
    end({ by: "operator" });
  }, [end]);

  const dismiss = useCallback(() => {
    setCall({ state: "idle" });
    setLines([]);
  }, []);

  // Gives up a call still being prepared (the microphone prompt, the setup request): the start sees
  // the attempt changed and stops there, and what it already holds is released now.
  const cancel = useCallback(() => {
    attempt.current++;
    for (const track of pendingMic.current?.getTracks() ?? []) track.stop();
    pendingMic.current = null;
    void pendingAudio.current?.close().catch(() => {});
    pendingAudio.current = null;
    setCall({ state: "idle" });
    setLines([]);
  }, []);

  return { call, lines, meters, start, hangUp, dismiss, cancel };
}
