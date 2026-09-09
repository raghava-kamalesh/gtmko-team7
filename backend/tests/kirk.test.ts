import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createDatabase, type DatabaseContext } from "../src/db.js";
import { runAssistantTurn } from "../src/grok.js";
import { cartSpreadPrompt, generateImagine, placeholderSvg } from "../src/imagine.js";
import { captureUnmetDemand, decidePurchase, getKirkHome } from "../src/kirk.js";
import { wiringFromEnv } from "../src/grokbot.js";

const json = async (response: Response) => response.json() as Promise<any>;

function grokReply(message: { content?: string | null; tool_calls?: unknown[] }) {
  return new Response(JSON.stringify({ choices: [{ message }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Kirk home and demand loop", () => {
  let context: DatabaseContext;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    context = await createDatabase("memory://kirk");
    app = createApp(context);
  });

  afterAll(async () => {
    await context.close();
  });

  it("returns history suggestions and member context", async () => {
    const response = await app.request("/kirk/home?memberKey=alex.johnson@example.com");
    expect(response.status).toBe(200);
    const payload = await json(response);
    expect(payload.data.member.displayName).toBe("Alex Johnson");
    expect(payload.data.suggestions.length).toBeGreaterThanOrEqual(4);
    expect(payload.data.suggestions[0].prompt).toMatch(/snack|laundry|TV|sectional|grill/i);
    expect(payload.data.suggestions[0].heroUrl).toBeTruthy();
    expect(payload.data.member.unmetInterests[0].text).toMatch(/whisky|wok/i);
  });

  it("captures unmet demand, blocks preorder until approve, then notifies", async () => {
    const created = await json(await app.request("/kirk/demand", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        memberKey: "alex.johnson@example.com",
        rawText: "I was actually looking for a Japanese whisky gift set",
        category: "grocery",
      }),
    }));
    expect(created.data.request.status).toBe("pending");

    const staff = await json(await app.request("/auth/staff-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "service@costco.demo", password: "CostcoDemo123!" }),
    }));
    const auth = { Authorization: `Bearer ${staff.data.token}`, "Content-Type": "application/json" };

    const pending = await json(await app.request("/admin/kirk/purchases", { headers: auth }));
    expect(pending.data.some((row: { status: string }) => row.status === "pending")).toBe(true);

    const rejected = await captureUnmetDemand(context.db, {
      memberKey: "jamie.chen@example.com",
      rawText: "nothing fits, I wanted fragrance-free baby wipes",
      category: "household",
    });
    const deny = await decidePurchase(context.db, {
      id: rejected.request!.id,
      action: "reject",
      staffKey: "service@costco.demo",
    });
    expect(deny.request?.status).toBe("rejected");
    expect(deny.preorderItem).toBeNull();

    const approved = await json(await app.request(`/admin/kirk/purchases/${created.data.request.id}/decide`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ action: "approve" }),
    }));
    expect(approved.data.request.status).toBe("approved");
    expect(approved.data.preorderItem.available).toBe(true);

    const home = await getKirkHome(context.db, "alex.johnson@example.com");
    expect(home.preorderItems.length).toBeGreaterThan(0);
    expect(home.notifications.some((row) => /preorder/i.test(row.body))).toBe(true);

    const mail = await json(await app.request("/admin/kirk/mail", { headers: auth }));
    expect(mail.data[0].toAddresses).toEqual(expect.arrayContaining([
      "raghava.kamalesh@anysphere.co",
      "pavan@anysphere.co",
    ]));
  });

  it("records member feedback and a GrokBot review packet", async () => {
    const response = await app.request("/kirk/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        memberKey: "demo",
        type: "bug",
        details: "Kirk added the wrong TV size to my cart",
        transcript: [{ role: "user", text: "65 inch TV" }],
      }),
    });
    expect(response.status).toBe(201);
    const payload = await json(response);
    expect(payload.data.linearIdentifier).toMatch(/KIRK-/);
    expect(payload.data.status).toBe("ready_for_review");
    expect(payload.data.wiring.linear).toBe("mocked");
  });

  it("mints a voice session descriptor", async () => {
    const response = await app.request("/assistant/voice/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ warehouse: { id: "w1", name: "Brooklyn" }, cartSummary: "1× bath tissue" }),
    });
    const payload = await json(response);
    expect(payload.data.wsPath).toBe("/assistant/voice/live");
    expect(payload.data.instructions).toMatch(/Kirk/);
    expect(payload.data.tools.some((tool: { name: string }) => tool.name === "add_to_cart")).toBe(true);
  });
});

describe("Kirk Imagine and Grok tools", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a placeholder image when Imagine is not configured", async () => {
    const previous = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    const result = await generateImagine({ kind: "category_hero", prompt: hero });
    process.env.XAI_API_KEY = previous;
    expect(result.source).toBe("placeholder");
    expect(result.url.startsWith("data:image/svg+xml")).toBe(true);
    expect(placeholderSvg("Hero", "test")).toContain("KIRK");
    expect(cartSpreadPrompt([{ name: "Bath Tissue", quantity: 1 }])).toMatch(/Bath Tissue/);
  });

  it("returns a placeholder when Imagine is configured but xAI is unreachable", async () => {
    const result = await generateImagine(
      { kind: "cart_spread", prompt: "party table" },
      { apiKey: "test-key", fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch },
    );
    expect(result.source).toBe("placeholder");
    expect(result.url.startsWith("data:image/svg+xml")).toBe(true);
  });

  it("returns cart add actions from the add_to_cart tool", async () => {
    const fetchMock = vi.fn(async () => grokReply({
      content: "I added Kirkland bath tissue to your cart.",
      tool_calls: [{
        id: "call-add",
        type: "function",
        function: { name: "add_to_cart", arguments: JSON.stringify({ product_id: "1", quantity: 2 }) },
      }],
    }));
    const result = await runAssistantTurn({
      messages: [{ role: "user", content: "Add the Kirkland bath tissue" }],
      warehouse: { id: "w1", name: "Brooklyn" },
      cart: [],
    }, { fetch: fetchMock as unknown as typeof fetch, apiKey: "test-key" });
    expect(result.cartActions).toEqual([{ productId: "1", quantity: 2 }]);
    expect(result.recommendations[0]?.id).toBe("1");
  });

  it("flags unmet demand from ordinary shopping language", async () => {
    const fetchMock = vi.fn(async () => grokReply({
      content: "I do not have that in the warehouse catalog.",
    }));
    const result = await runAssistantTurn({
      messages: [{ role: "user", content: "I was actually looking for a Japanese whisky gift set" }],
      warehouse: { id: "w1", name: "Brooklyn" },
    }, { fetch: fetchMock as unknown as typeof fetch, apiKey: "test-key" });
    expect(result.unmetDemand?.rawText).toMatch(/whisky/i);
  });

  it("reports mocked wiring when third-party keys are absent", () => {
    const wiring = wiringFromEnv({} as NodeJS.ProcessEnv);
    expect(wiring).toEqual({ linear: "mocked", cloudAgent: "mocked", xSearch: "mocked", email: "mocked" });
  });
});

const hero = "Photorealistic grocery aisle";
