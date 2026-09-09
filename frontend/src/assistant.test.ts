import { describe, expect, it } from "vitest";
import { insertAfterLine, type ChatLine } from "./assistant";

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
