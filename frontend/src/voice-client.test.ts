import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeVoiceUtterance, resampleTo24k, VoiceUtteranceBuffer, voiceTranscriptFromEvent } from "./voice-client";

describe("voice client helpers", () => {
  it("resamples hardware-rate PCM down to 24 kHz", () => {
    const input = new Float32Array(4800);
    input[0] = 1;
    input[4799] = -1;
    const out = resampleTo24k(input, 48000);
    expect(out.length).toBe(2400);
    expect(out[0]).toBeCloseTo(1, 5);
  });

  it("keeps 24 kHz audio unchanged", () => {
    const input = new Float32Array([0.25, -0.5]);
    expect(resampleTo24k(input, 24000)).toBe(input);
  });

  it("reads finished user and assistant transcripts from xAI event names", () => {
    expect(voiceTranscriptFromEvent({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "I need a TV",
    })).toEqual({ role: "user", text: "I need a TV" });
    expect(voiceTranscriptFromEvent({
      type: "response.output_audio_transcript.done",
      transcript: "The 77 inch OLED is in stock.",
    })).toEqual({ role: "assistant", text: "The 77 inch OLED is in stock." });
    expect(voiceTranscriptFromEvent({
      type: "response.output_audio.delta",
      delta: "aaaa",
    })).toBeNull();
  });
});

describe("voice utterance buffer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the longer finished phrase when partials and duplicates arrive", () => {
    expect(mergeVoiceUtterance("", "Okay show")).toBe("Okay show");
    expect(mergeVoiceUtterance("Okay show", "Okay show it to me.")).toBe("Okay show it to me.");
    expect(mergeVoiceUtterance("Okay show it to me.", "Okay show it to me.")).toBe("Okay show it to me.");
    expect(mergeVoiceUtterance("Okay show it to me.", "Okay show")).toBe("Okay show it to me.");
  });

  it("commits one utterance only after 3 seconds of silence", () => {
    vi.useFakeTimers();
    const commits: string[] = [];
    const buffer = new VoiceUtteranceBuffer((text) => commits.push(text));
    buffer.hear("Okay show");
    buffer.noteSpeech();
    vi.advanceTimersByTime(500);
    buffer.hear("Okay show it to me.");
    buffer.hear("Okay show it to me.");
    buffer.hear("Okay show it to me.");
    vi.advanceTimersByTime(2999);
    expect(commits).toEqual([]);
    buffer.noteQuiet();
    vi.advanceTimersByTime(2999);
    expect(commits).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(commits).toEqual(["Okay show it to me."]);
    buffer.hear("Okay show it to me.");
    buffer.noteQuiet();
    vi.advanceTimersByTime(3000);
    expect(commits).toEqual(["Okay show it to me."]);
  });
});
