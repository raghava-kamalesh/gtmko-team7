import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createDatabase, type DatabaseContext } from "../src/db.js";
import { runAssistantTurn } from "../src/grok.js";
import { listPurchaseRequests } from "../src/kirk.js";
import { searchStorefrontCatalog } from "../src/storefront-catalog.js";

const json = async (response: Response) => response.json() as Promise<any>;

function grokReply(message: { content?: string | null; tool_calls?: unknown[] }) {
  return new Response(JSON.stringify({ choices: [{ message }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("storefront catalog search", () => {
  it("matches demo tissue and catalog TVs from ordinary shopping language", () => {
    const tissue = searchStorefrontCatalog("Kirkland bath tissue");
    expect(tissue.some((item) => item.id === "1")).toBe(true);
    const tvs = searchStorefrontCatalog("65 inch tv", { warehouseId: "w1" });
    expect(tvs.some((item) => item.id === "4" || item.id === "9565020")).toBe(true);
    expect(tvs[0]?.memberPrice).toBeGreaterThan(0);
  });
});

describe("Grok assistant turn", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a recommendation when Grok names a catalog id", async () => {
    const fetchMock = vi.fn(async () => grokReply({
      content: "The Sony 65-inch BRAVIA is $698.00 and a strong member value. Would you like to see the product page?",
      tool_calls: [{
        id: "call-rec",
        type: "function",
        function: { name: "recommend_products", arguments: JSON.stringify({ product_ids: ["9565020"] }) },
      }],
    }));
    const result = await runAssistantTurn({
      messages: [{ role: "user", content: "I need a 65 inch TV" }],
      warehouse: { id: "w1", name: "Brooklyn" },
    }, { fetch: fetchMock as unknown as typeof fetch, apiKey: "test-key" });
    expect(result.askToView).toBe(true);
    expect(result.recommendations[0]).toMatchObject({ id: "9565020", brand: "Sony" });
    expect(result.reply).toMatch(/product page/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls.at(0) as [unknown, RequestInit] | undefined;
    const requestInit = firstCall?.[1] ?? {};
    const request = JSON.parse(String(requestInit.body ?? "{}")) as { model?: string };
    expect(request.model).toBe(process.env.XAI_MODEL ?? "grok-4.6");
  });

  it("falls back to catalog matches when Grok is unreachable", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await runAssistantTurn({
      messages: [{ role: "user", content: "I need a 65 inch TV" }],
      warehouse: { id: "w1", name: "Brooklyn" },
    }, { fetch: fetchMock as unknown as typeof fetch, apiKey: "test-key" });
    expect(result.askToView).toBe(true);
    expect(result.recommendations.some((item) => /tv|bravia|television/i.test(`${item.id} ${item.name}`))).toBe(true);
    expect(result.reply).toMatch(/product page|\$/i);
    expect(result.cartActions).toEqual([]);
  });

  it("adds a catalog match when Grok is down and the member asks to add it", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await runAssistantTurn({
      messages: [{ role: "user", content: "Add the Kirkland bath tissue" }],
      warehouse: { id: "w1", name: "Brooklyn" },
    }, { fetch: fetchMock as unknown as typeof fetch, apiKey: "test-key" });
    expect(result.cartActions[0]?.productId).toBeTruthy();
    expect(result.recommendations[0]?.name).toMatch(/bath tissue/i);
    expect(result.cartActions[0]?.productId).toBe(result.recommendations[0]?.id);
  });

  it("asks to request inventory when Grok is down and the member was looking for something else", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await runAssistantTurn({
      messages: [{ role: "user", content: "I was actually looking for a Japanese whisky gift set" }],
      warehouse: { id: "w1", name: "Brooklyn" },
    }, { fetch: fetchMock as unknown as typeof fetch, apiKey: "test-key" });
    expect(result.recommendations).toEqual([]);
    expect(result.unmetDemand).toBeNull();
    expect(result.askToRequestInventory).toBe(true);
    expect(result.reply).toMatch(/request it be added to inventory/i);
  });

  it("records the inventory request after the member agrees", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await runAssistantTurn({
      messages: [
        { role: "user", content: "I was actually looking for a Japanese whisky gift set" },
        { role: "assistant", content: "I don't have that in this warehouse catalog. Would you like me to request it be added to inventory? You can describe exactly what you want." },
        { role: "user", content: "Yes, a 12-year Yamazaki gift box" },
      ],
      warehouse: { id: "w1", name: "Brooklyn" },
    }, { fetch: fetchMock as unknown as typeof fetch, apiKey: "test-key" });
    expect(result.askToRequestInventory).toBe(false);
    expect(result.unmetDemand?.rawText).toMatch(/Yamazaki|whisky/i);
    expect(result.reply).toMatch(/sent that request to merch/i);
  });

  it("does not log unmet demand when the member declines the inventory request", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await runAssistantTurn({
      messages: [
        { role: "user", content: "Do you sell Japanese whisky gift sets?" },
        { role: "assistant", content: "I don't have that in this warehouse catalog. Would you like me to request it be added to inventory?" },
        { role: "user", content: "No thanks" },
      ],
      warehouse: { id: "w1", name: "Brooklyn" },
    }, { fetch: fetchMock as unknown as typeof fetch, apiKey: "test-key" });
    expect(result.askToRequestInventory).toBe(false);
    expect(result.unmetDemand).toBeNull();
    expect(result.reply).toMatch(/keep looking/i);
  });

  it("runs a search tool round before answering", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const last = body.messages.at(-1);
      if (last?.role === "tool") {
        return grokReply({
          content: "Kirkland bath tissue is the warehouse staple. Would you like to see the product page?",
          tool_calls: [{
            id: "call-rec",
            type: "function",
            function: { name: "recommend_products", arguments: JSON.stringify({ product_ids: ["1"] }) },
          }],
        });
      }
      return grokReply({
        content: null,
        tool_calls: [{
          id: "call-search",
          type: "function",
          function: { name: "search_catalog", arguments: JSON.stringify({ query: "bath tissue" }) },
        }],
      });
    });
    const result = await runAssistantTurn({
      messages: [{ role: "user", content: "I need toilet paper" }],
      warehouse: { id: "w2", name: "Manhattan" },
    }, { fetch: fetchMock as unknown as typeof fetch, apiKey: "test-key" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.recommendations[0]?.id).toBe("1");
  });

  it("fails closed when the API key is missing", async () => {
    await expect(runAssistantTurn({
      messages: [{ role: "user", content: "TV" }],
      warehouse: { id: "w1", name: "Brooklyn" },
    }, { apiKey: "" })).rejects.toMatchObject({ status: 503, code: "GROK_NOT_CONFIGURED" });
  });
});

describe("POST /assistant/chat", () => {
  let context: DatabaseContext | undefined;
  let app: ReturnType<typeof createApp>;

  afterEach(async () => {
    vi.unstubAllGlobals();
    await context?.close();
  });

  it("validates the body and proxies a Grok recommendation", async () => {
    context = await createDatabase("memory://");
    app = createApp(context);
    const invalid = await app.request("/assistant/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(invalid.status).toBe(422);

    vi.stubGlobal("fetch", async () => grokReply({
      content: "I recommend the 65-inch 4K Smart TV. Would you like to see the product page?",
      tool_calls: [{
        id: "call-rec",
        type: "function",
        function: { name: "recommend_products", arguments: JSON.stringify({ product_ids: ["4"] }) },
      }],
    }));
    const previous = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "test-key";
    const response = await app.request("/assistant/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Show me a TV" }],
        warehouse: { id: "w1", name: "Brooklyn" },
      }),
    });
    process.env.XAI_API_KEY = previous;
    expect(response.status).toBe(200);
    const payload = await json(response);
    expect(payload.data.recommendations[0].id).toBe("4");
    expect(payload.data.askToView).toBe(true);
  });

  it("asks before writing a missing product to the merch queue", async () => {
    context = await createDatabase("memory://inventory-request");
    app = createApp(context);
    vi.stubGlobal("fetch", async () => grokReply({
      content: "I do not have that in the warehouse catalog.",
    }));
    const previous = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "test-key";
    const first = await app.request("/assistant/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "I was actually looking for a Japanese whisky gift set" }],
        warehouse: { id: "w1", name: "Brooklyn" },
        memberKey: "alex.johnson@example.com",
      }),
    });
    expect(first.status).toBe(200);
    const asked = await json(first);
    expect(asked.data.askToRequestInventory).toBe(true);
    expect(asked.data.unmetDemand).toBeNull();
    expect(asked.data.reply).toMatch(/request it be added to inventory/i);
    expect(await listPurchaseRequests(context.db)).toEqual([]);

    const confirm = await app.request("/assistant/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "I was actually looking for a Japanese whisky gift set" },
          { role: "assistant", content: asked.data.reply },
          { role: "user", content: "Yes, a 12-year Yamazaki gift box" },
        ],
        warehouse: { id: "w1", name: "Brooklyn" },
        memberKey: "alex.johnson@example.com",
      }),
    });
    process.env.XAI_API_KEY = previous;
    expect(confirm.status).toBe(200);
    const recorded = await json(confirm);
    expect(recorded.data.askToRequestInventory).toBe(false);
    expect(recorded.data.unmetDemand?.rawText).toMatch(/Yamazaki|whisky/i);
    const queued = await listPurchaseRequests(context.db);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.status).toBe("pending");
    expect(queued[0]?.memberKey).toBe("alex.johnson@example.com");
    expect(`${queued[0]?.query} ${recorded.data.unmetDemand?.rawText}`).toMatch(/Yamazaki|whisky/i);
  });
});
