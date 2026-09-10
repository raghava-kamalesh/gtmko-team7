import { describe, expect, it } from "vitest";
import { insertAfterLine, upsertVoiceLine, type ChatLine } from "./assistant";

const line = (id: string, role: ChatLine["role"], text: string): ChatLine => ({ id, role, text });

describe("insertAfterLine", () => {
  it("places the reply immediately after the matching question", () => {
    const user = line("u1", "user", "Need a TV");
    const extra = line("u2", "user", "also snacks");
    const reply = line("a1", "assistant", "The 77 inch OLED is in stock.");
    const next = insertAfterLine([user, extra], "u1", reply);
    expect(next.map((item) => item.id)).toEqual(["u1", "a1", "u2"]);
  });

  it("appends when the question id is missing", () => {
    const reply = line("a1", "assistant", "Hello");
    expect(insertAfterLine([line("u1", "user", "Hi")], "missing", reply).map((item) => item.id)).toEqual(["u1", "a1"]);
  });
});

describe("upsertVoiceLine", () => {
  it("merges repeated user transcripts into one bubble", () => {
    const first = upsertVoiceLine([], "user", "Okay show");
    const next = upsertVoiceLine(first, "user", "Okay show it to me.");
    const duped = upsertVoiceLine(next, "user", "Okay show it to me.");
    expect(duped).toHaveLength(1);
    expect(duped[0]?.text).toBe("Okay show it to me.");
  });

  it("starts a new bubble after the other speaker", () => {
    const user = upsertVoiceLine([], "user", "I need a TV");
    const assistant = upsertVoiceLine(user, "assistant", "The Sony 65-inch is in stock.", { productIds: ["9565020"] });
    expect(assistant).toHaveLength(2);
    expect(assistant[1]?.productIds).toEqual(["9565020"]);
  });
});
