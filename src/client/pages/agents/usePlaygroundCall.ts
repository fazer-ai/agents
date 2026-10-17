// A call to the agent from the playground: the browser's microphone in place of the WhatsApp line.
// It speaks the frames the whatsapp-connector speaks on a real call (`start`, `answered`, `media`
// with base64 PCM at 16 kHz mono, `stop`), and plays what comes back (`media`, `clear` when the
// person talks over the agent, `hangup` with who ended it), plus the `ready`, `transcript` and `tool`
// frames only this route sends. The line sounds like a phone: ringback while the engine connects,
// the busy tone when the call ends.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/client/lib/api";

const RATE = 16_000;
// 64 ms per frame: what ScriptProcessorNode accepts closest to the 20 to 60 ms a call sends.
const FRAME = 1024;
// The Brazilian line tones: 425 Hz, ringback 1 s on and 4 s off, busy 250 ms on and off.
const TONE_HZ = 425;
// How often the meters on the screen are refreshed.
const METER_MS = 100;

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
  agentSpeaking: boolean;
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
  l.playing.add(source);
  source.onended = () => l.playing.delete(source);
}

function clear(l: Live) {
  for (const source of l.playing) source.stop();
  l.playing.clear();
  l.next = l.audio.currentTime;
}

export function usePlaygroundCall(agentId: string) {
  const [call, setCall] = useState<CallState>({ state: "idle" });
  const [lines, setLines] = useState<CallLine[]>([]);
  const [meters, setMeters] = useState<CallMeters>({
    mic: 0,
    agentSpeaking: false,
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
      void pendingAudio.current?.close();
      pendingAudio.current = null;
      release(0);
    },
    [release],
  );

  // The meters, refreshed while the line is up.
  const up = call.state === "ringing" || call.state === "live";
  useEffect(() => {
    if (!up) {
      setMeters({ mic: 0, agentSpeaking: false });
      return;
    }
    const timer = setInterval(() => {
      const l = live.current;
      if (!l) return;
      setMeters({
        mic: l.micPeak,
        agentSpeaking: l.next > l.audio.currentTime,
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

  const start = useCallback(async () => {
    if (live.current) return;
    const mine = ++attempt.current;
    setLines([]);
    setCall({ state: "preparing" });
    // Made and resumed in the click itself: Safari starts Web Audio only inside a user gesture, and the
    // microphone prompt and the setup request below both end it. The context runs at the call's rate,
    // so the browser resamples the microphone and the agent.
    const audio = new AudioContext({ sampleRate: RATE });
    pendingAudio.current = audio;
    const unlocked = audio.resume().catch(() => {});
    const dropAudio = () => {
      pendingAudio.current = null;
      void audio.close();
    };
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
      pendingMic.current = null;
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
    pendingAudio.current = null;
    const node = audio.createScriptProcessor(FRAME, 1, 1);
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
      if (ws.readyState !== WebSocket.OPEN || !l.answeredAt) return;
      const pcm = Int16Array.from(input, (s) =>
        Math.max(-0x8000, Math.min(0x7fff, Math.round(s * 0x8000))),
      );
      ws.send(JSON.stringify({ event: "media", payload: toBase64(pcm) }));
    };
    audio.createMediaStreamSource(mic).connect(node);
    // A ScriptProcessorNode only runs while connected; its output stays silent.
    node.connect(audio.destination);

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
  }, [agentId, end]);

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

  return { call, lines, meters, start, hangUp, dismiss };
}
