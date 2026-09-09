import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createDatabase, type DatabaseContext } from "../src/db.js";
import { runAssistantTurn } from "../src/grok.js";
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
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as { model?: string };
    expect(request.model).toBe(process.env.XAI_MODEL ?? "grok-4.20-0309-non-reasoning");
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
});
