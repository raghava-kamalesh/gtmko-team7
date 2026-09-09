export type VoiceStatus = "idle" | "connecting" | "live" | "reconnecting" | "error";

export type VoiceHandlers = {
  onStatus: (status: VoiceStatus, detail?: string) => void;
  onTranscript?: (role: "user" | "assistant", text: string) => void;
  onTool?: (name: string, args: Record<string, unknown>) => void;
};

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
  if (type === "response.output_audio_transcript.done" || type === "response.output_text.done") {
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
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin);
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

  async start(session: { wsPath: string; instructions: string; tools: unknown[]; voice?: string; model: string }) {
    this.stopped = false;
    this.started = false;
    this.assistantBuf = "";
    this.handlers.onStatus("connecting", "Connecting to Grok Voice…");
    try {
      this.media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.handlers.onStatus("error", "Microphone permission is required for live voice.");
      return;
    }
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const query = this.conversationId ? `?conversation_id=${encodeURIComponent(this.conversationId)}` : "";
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
    void this.inputCtx?.close();
    void this.outputCtx?.close();
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
        turn_detection: { type: "server_vad", silence_duration_ms: 600 },
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription: { model: "grok-transcribe" },
          },
          output: { format: { type: "audio/pcm", rate: 24000 } },
        },
        tools: session.tools,
      },
    }));
    this.handlers.onStatus("live", "Listening — speak after the waveform is live.");
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
    if (type === "response.output_audio_transcript.delta" && typeof payload.delta === "string") {
      this.assistantBuf += payload.delta;
    }
    if (type === "response.output_text.delta" && typeof payload.delta === "string") {
      this.assistantBuf += payload.delta;
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
    if (!this.media) return;
    this.inputCtx = new AudioContext({ sampleRate: 24000 });
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
    const raw = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const frames = raw.length / 2;
    const buffer = this.outputCtx.createBuffer(1, frames, 24000);
    const channel = buffer.getChannelData(0);
    const view = new DataView(raw.buffer);
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
