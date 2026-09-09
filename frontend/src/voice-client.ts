export type VoiceStatus = "idle" | "connecting" | "live" | "reconnecting" | "error";

export type VoiceHandlers = {
  onStatus: (status: VoiceStatus, detail?: string) => void;
  onTranscript?: (role: "user" | "assistant", text: string) => void;
  onTool?: (name: string, args: Record<string, unknown>) => void;
};

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

  constructor(private readonly handlers: VoiceHandlers) {}

  async start(session: { wsPath: string; instructions: string; tools: unknown[]; voice?: string; model: string }) {
    this.stopped = false;
    this.handlers.onStatus("connecting");
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
    this.socket.addEventListener("open", () => {
      this.socket?.send(JSON.stringify({
        type: "session.update",
        session: {
          voice: session.voice ?? "eve",
          instructions: session.instructions,
          turn_detection: { type: "server_vad", silence_duration_ms: 600 },
          audio: {
            input: { format: { type: "audio/pcm", rate: 24000 } },
            output: { format: { type: "audio/pcm", rate: 24000 } },
          },
          tools: session.tools,
          resumption: { enabled: true },
        },
      }));
      this.handlers.onStatus("live");
      this.pumpMic();
    });
    this.socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
      this.handleEvent(payload);
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

  private handleEvent(payload: Record<string, unknown>) {
    const type = String(payload.type ?? "");
    if (type === "error") {
      const error = payload.error as { message?: string } | undefined;
      this.handlers.onStatus("error", error?.message ?? "Voice session error");
    }
    if (type === "conversation.created") {
      const conversation = payload.conversation as { id?: string } | undefined;
      if (conversation?.id) this.conversationId = conversation.id;
    }
    if (type === "response.output_audio.delta" && typeof payload.delta === "string") {
      this.playDelta(payload.delta);
    }
    if (type === "response.output_text.delta" && typeof payload.delta === "string") {
      this.handlers.onTranscript?.("assistant", payload.delta);
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
    this.processor.onaudioprocess = (event) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      const pcm = pcm16FromFloat32(event.inputBuffer.getChannelData(0));
      this.socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: bytesToBase64(pcm) }));
    };
    source.connect(this.processor);
    this.processor.connect(this.inputCtx.destination);
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
