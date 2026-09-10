export type VoiceStatus = "idle" | "connecting" | "live" | "reconnecting" | "error";

export const VOICE_SILENCE_MS = 800;
export const VOICE_SPEECH_RMS = 0.015;

export type VoiceHandlers = {
  onStatus: (status: VoiceStatus, detail?: string) => void;
  onTranscript?: (role: "user" | "assistant", text: string) => void;
  onProducts?: (productIds: string[]) => void;
  onTool?: (name: string, args: Record<string, unknown>) => void;
};

export function normalizeVoiceText(text: string): string {
  return text.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

export function mergeVoiceUtterance(current: string, incoming: string): string {
  const next = incoming.trim().replace(/\s+/g, " ");
  const prev = current.trim().replace(/\s+/g, " ");
  if (!next) return prev;
  if (!prev) return next;
  const prevNorm = normalizeVoiceText(prev);
  const nextNorm = normalizeVoiceText(next);
  if (!nextNorm || nextNorm === prevNorm) return prev.length >= next.length ? prev : next;
  if (nextNorm.includes(prevNorm)) return next;
  if (prevNorm.includes(nextNorm)) return prev;
  return `${prev} ${next}`.replace(/\s+/g, " ");
}

export function audioRms(input: Float32Array): number {
  if (!input.length) return 0;
  let sum = 0;
  for (let i = 0; i < input.length; i += 1) sum += (input[i] ?? 0) ** 2;
  return Math.sqrt(sum / input.length);
}

type TimerHandle = ReturnType<typeof setTimeout>;

export class VoiceUtteranceBuffer {
  private draft = "";
  private timer: TimerHandle | null = null;
  private committed = false;
  private waitingForTranscript = false;

  constructor(
    private readonly onCommit: (text: string) => void,
    private readonly silenceMs = 3000,
    private readonly schedule: {
      setTimeout: typeof setTimeout;
      clearTimeout: typeof clearTimeout;
    } = {
      setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
      clearTimeout: (id) => globalThis.clearTimeout(id),
    },
  ) {}

  peek() {
    return this.draft;
  }

  hear(text: string) {
    if (this.committed) return this.draft;
    this.draft = mergeVoiceUtterance(this.draft, text);
    if (this.waitingForTranscript && this.draft) this.commit();
    return this.draft;
  }

  noteSpeech() {
    if (this.committed) return;
    this.waitingForTranscript = false;
    this.clearTimer();
  }

  noteQuiet() {
    if (this.committed || this.timer) return;
    this.timer = this.schedule.setTimeout(() => {
      this.timer = null;
      if (this.draft) {
        this.commit();
        return;
      }
      this.waitingForTranscript = true;
      this.timer = this.schedule.setTimeout(() => {
        this.timer = null;
        this.waitingForTranscript = false;
      }, 2000);
    }, this.silenceMs);
  }

  flush() {
    if (this.draft) this.commit();
  }

  clear() {
    this.clearTimer();
    this.waitingForTranscript = false;
  }

  private commit() {
    if (this.committed) return;
    const text = this.draft.trim();
    if (!text) return;
    this.committed = true;
    this.clear();
    this.onCommit(text);
  }

  private clearTimer() {
    if (this.timer) this.schedule.clearTimeout(this.timer);
    this.timer = null;
  }
}

export function resampleTo24k(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === 24000) return input;
  const ratio = 24000 / fromRate;
  const out = new Float32Array(Math.max(1, Math.floor(input.length * ratio)));
  for (let i = 0; i < out.length; i += 1) {
    const src = i / ratio;
    const i0 = Math.min(Math.floor(src), input.length - 1);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = src - i0;
    out[i] = (input[i0] ?? 0) * (1 - t) + (input[i1] ?? 0) * t;
  }
  return out;
}

export function voiceTranscriptFromEvent(payload: Record<string, unknown>): { role: "user" | "assistant"; text: string } | null {
  const type = String(payload.type ?? "");
  if (type === "conversation.item.input_audio_transcription.completed") {
    const text = String(payload.transcript ?? "").trim();
    return text ? { role: "user", text } : null;
  }
  if (
    type === "response.output_audio_transcript.done"
    || type === "response.audio_transcript.done"
    || type === "response.output_text.done"
  ) {
    const text = String(payload.transcript ?? payload.text ?? "").trim();
    return text ? { role: "assistant", text } : null;
  }
  return null;
}

function pcm16FromFloat32(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  const raw = new Uint8Array(bytes);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < raw.length; i += chunk) {
    bin += String.fromCharCode(...raw.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function closeAudio(ctx: AudioContext | null) {
  if (ctx && ctx.state !== "closed") void ctx.close();
}

export class KirkVoiceSession {
  private socket: WebSocket | null = null;
  private media: MediaStream | null = null;
  private inputCtx: AudioContext | null = null;
  private outputCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private playTime = 0;
  private conversationId: string | null = null;
  private stopped = false;
  private started = false;
  private assistantBuf = "";

  constructor(private readonly handlers: VoiceHandlers) {}

  async start(session: { wsPath: string; instructions: string; tools: unknown[]; voice?: string; model: string; warehouseId?: string }) {
    this.stopped = false;
    this.started = false;
    this.assistantBuf = "";
    this.playTime = 0;
    this.handlers.onStatus("connecting", "Connecting to Grok Voice…");
    try {
      this.media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.handlers.onStatus("error", "Microphone permission is required for live voice.");
      return;
    }
    this.inputCtx = new AudioContext({ sampleRate: 24000 });
    this.outputCtx = new AudioContext({ sampleRate: 24000 });
    await this.inputCtx.resume().catch(() => undefined);
    await this.outputCtx.resume().catch(() => undefined);
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const params = new URLSearchParams();
    if (this.conversationId) params.set("conversation_id", this.conversationId);
    if (session.warehouseId) params.set("warehouse_id", session.warehouseId);
    const query = params.size ? `?${params}` : "";
    const url = `${protocol}://${location.host}/api${session.wsPath}${query}`;
    this.socket = new WebSocket(url);
    this.socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
      this.handleEvent(payload, session);
    });
    this.socket.addEventListener("close", () => {
      if (this.stopped) {
        this.handlers.onStatus("idle");
        return;
      }
      this.handlers.onStatus("reconnecting", "Voice dropped. Reconnecting…");
      window.setTimeout(() => {
        if (!this.stopped) void this.start(session);
      }, 1200);
    });
    this.socket.addEventListener("error", () => {
      this.handlers.onStatus("error", "Could not reach Grok Voice. Check XAI_API_KEY and try again.");
    });
  }

  stop() {
    this.stopped = true;
    this.processor?.disconnect();
    this.media?.getTracks().forEach((track) => track.stop());
    closeAudio(this.inputCtx);
    closeAudio(this.outputCtx);
    this.inputCtx = null;
    this.outputCtx = null;
    this.socket?.close();
    this.socket = null;
    this.handlers.onStatus("idle");
  }

  private begin(session: { instructions: string; tools: unknown[]; voice?: string }) {
    if (this.started || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.started = true;
    this.socket.send(JSON.stringify({
      type: "session.update",
      session: {
        voice: session.voice ?? "eve",
        instructions: session.instructions,
        turn_detection: { type: "server_vad", silence_duration_ms: VOICE_SILENCE_MS },
        audio: {
          input: { format: { type: "audio/pcm", rate: 24000 } },
          output: { format: { type: "audio/pcm", rate: 24000 } },
        },
        tools: session.tools,
      },
    }));
    this.handlers.onStatus("live", "Listening — speak and Kirk will answer out loud.");
    this.pumpMic();
  }

  private handleEvent(payload: Record<string, unknown>, session: { instructions: string; tools: unknown[]; voice?: string }) {
    const type = String(payload.type ?? "");
    if (type === "error") {
      const error = payload.error as { message?: string } | undefined;
      this.handlers.onStatus("error", error?.message ?? "Voice session error");
      return;
    }
    if (type === "proxy.ready" || type === "session.created") {
      this.begin(session);
    }
    if (type === "conversation.created") {
      const conversation = payload.conversation as { id?: string } | undefined;
      if (conversation?.id) this.conversationId = conversation.id;
    }
    if ((type === "response.output_audio.delta" || type === "response.audio.delta") && typeof payload.delta === "string") {
      this.playDelta(payload.delta);
    }
    if (type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") {
      if (typeof payload.delta === "string") this.assistantBuf += payload.delta;
    }
    if (type === "kirk.products" && Array.isArray(payload.productIds)) {
      this.handlers.onProducts?.(payload.productIds.map((id) => String(id)));
    }
    const line = voiceTranscriptFromEvent({
      ...payload,
      transcript: payload.transcript ?? (type.endsWith(".done") ? this.assistantBuf : payload.transcript),
    });
    if (line) {
      if (line.role === "assistant") this.assistantBuf = "";
      this.handlers.onTranscript?.(line.role, line.text);
    }
    if (type === "response.function_call_arguments.done") {
      const name = String(payload.name ?? payload.function_name ?? "");
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(String(payload.arguments ?? "{}")) as Record<string, unknown>; } catch { args = {}; }
      if (name) this.handlers.onTool?.(name, args);
    }
  }

  private pumpMic() {
    if (!this.media || !this.inputCtx) return;
    const source = this.inputCtx.createMediaStreamSource(this.media);
    this.processor = this.inputCtx.createScriptProcessor(4096, 1, 1);
    const mute = this.inputCtx.createGain();
    mute.gain.value = 0;
    this.processor.onaudioprocess = (event) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      const rate = this.inputCtx?.sampleRate ?? 24000;
      const pcm = pcm16FromFloat32(resampleTo24k(event.inputBuffer.getChannelData(0), rate));
      this.socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: bytesToBase64(pcm) }));
    };
    source.connect(this.processor);
    this.processor.connect(mute);
    mute.connect(this.inputCtx.destination);
  }

  private playDelta(b64: string) {
    this.outputCtx ??= new AudioContext({ sampleRate: 24000 });
    if (this.outputCtx.state === "suspended") void this.outputCtx.resume();
    const raw = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const frames = raw.length / 2;
    if (!frames) return;
    const buffer = this.outputCtx.createBuffer(1, frames, 24000);
    const channel = buffer.getChannelData(0);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i < frames; i += 1) {
      channel[i] = view.getInt16(i * 2, true) / 0x8000;
    }
    const source = this.outputCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.outputCtx.destination);
    const startAt = Math.max(this.outputCtx.currentTime, this.playTime);
    source.start(startAt);
    this.playTime = startAt + buffer.duration;
  }
}
