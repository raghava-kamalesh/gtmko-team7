import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createDatabase, type DatabaseContext } from "../src/db.js";
import { catalogSearchText, priceConstraintFromMessages, runAssistantTurn } from "../src/grok.js";
import { listPurchaseRequests } from "../src/kirk.js";
import { parsePriceConstraint, searchStorefrontCatalog } from "../src/storefront-catalog.js";

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

  it("does not treat a missing specialty product as a weak catalog hit", () => {
    expect(searchStorefrontCatalog("Do you sell Japanese whisky gift sets?")).toEqual([]);
  });

  it("parses max-price phrases used in Kirk chat", () => {
    expect(parsePriceConstraint("only under 400 for coffee table")).toEqual({ maxPrice: 400 });
    expect(parsePriceConstraint("Only under $400 for the coffee table.")).toEqual({ maxPrice: 400 });
    expect(parsePriceConstraint("65 inch TV under $800")).toEqual({ maxPrice: 800 });
    expect(parsePriceConstraint("between $200 and $400")).toEqual({ minPrice: 200, maxPrice: 400 });
    expect(parsePriceConstraint("at least $100")).toEqual({ minPrice: 100 });
    expect(parsePriceConstraint("over 65 inch TV")).toEqual({});
  });

  it("applies under-N filters so over-budget coffee tables are excluded", () => {
    const unfiltered = searchStorefrontCatalog("coffee table");
    expect(unfiltered.some((item) => item.memberPrice > 400)).toBe(true);
    expect(unfiltered.some((item) => /Mellina/i.test(item.name))).toBe(true);

    const filtered = searchStorefrontCatalog("only under 400 for coffee table");
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((item) => item.memberPrice <= 400)).toBe(true);
    expect(filtered.some((item) => /Point Cabrillo/i.test(item.name))).toBe(true);
    expect(filtered.some((item) => /Whitlee/i.test(item.name))).toBe(true);
    expect(filtered.some((item) => /Mellina/i.test(item.name))).toBe(false);
    expect(filtered.some((item) => item.id === "4000213231")).toBe(false);
    expect(filtered.some((item) => /SSD|Monitor|Recliner/i.test(item.name))).toBe(false);
  });

  it("honors an explicit maxPrice when the query has no price words", () => {
    const filtered = searchStorefrontCatalog("coffee table", { maxPrice: 400 });
    expect(filtered.every((item) => item.memberPrice <= 400)).toBe(true);
    expect(filtered.some((item) => item.memberPrice > 400)).toBe(false);
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

  it("asks to request inventory when Grok is down and the catalog has no real match", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await runAssistantTurn({
      messages: [{ role: "user", content: "Do you sell Japanese whisky gift sets?" }],
      warehouse: { id: "w1", name: "Brooklyn" },
    }, { fetch: fetchMock as unknown as typeof fetch, apiKey: "test-key" });
    expect(result.recommendations).toEqual([]);
    expect(result.unmetDemand).toBeNull();
    expect(result.askToRequestInventory).toBe(true);
    expect(result.reply).toMatch(/request it be added to inventory/i);
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
    expect(result.unmetDemand?.rawText).toMatch(/Yamazaki/i);
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

  it("keeps a price-only follow-up attached to the previous product search", () => {
    const messages = [
      { role: "user" as const, content: "Show me a good coffee table" },
      { role: "assistant" as const, content: "The Mellina set is $449.99." },
      { role: "user" as const, content: "only under 400" },
    ];
    expect(priceConstraintFromMessages(messages)).toEqual({ maxPrice: 400 });
    expect(catalogSearchText(messages, messages[2]!)).toMatch(/coffee table/i);
    expect(catalogSearchText(messages, messages[2]!)).toMatch(/under 400/i);
    expect(priceConstraintFromMessages([
      { role: "user", content: "coffee table under 400" },
      { role: "assistant", content: "Here are two tables." },
      { role: "user", content: "I need a 65 inch TV" },
    ])).toEqual({});
  });

  it("does not recommend over-budget items when Grok is down and the member set a max price", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await runAssistantTurn({
      messages: [
        { role: "user", content: "Show me a good coffee table" },
        { role: "assistant", content: "The Point Cabrillo Round Storage Lift-Top Coffee Table is $349.99." },
        { role: "user", content: "only under 400 for coffee table" },
      ],
      warehouse: { id: "w1", name: "Brooklyn" },
    }, { fetch: fetchMock as unknown as typeof fetch, apiKey: "test-key" });
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations.every((item) => item.memberPrice <= 400)).toBe(true);
    expect(result.recommendations.some((item) => /Mellina/i.test(item.name))).toBe(false);
  });

  it("applies a price-only follow-up to the earlier coffee table search when Grok is down", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await runAssistantTurn({
      messages: [
        { role: "user", content: "Show me a good coffee table" },
        { role: "assistant", content: "The Mellina 3-piece Occasional Table Set is $449.99." },
        { role: "user", content: "only under 400" },
      ],
      warehouse: { id: "w1", name: "Brooklyn" },
    }, { fetch: fetchMock as unknown as typeof fetch, apiKey: "test-key" });
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations.every((item) => item.memberPrice <= 400)).toBe(true);
    expect(result.recommendations.some((item) => /Mellina/i.test(item.name))).toBe(false);
  });

  it("drops recommend_products ids that break the member's max price", async () => {
    const fetchMock = vi.fn(async () => grokReply({
      content: "The Mellina set is a nice coffee table option.",
      tool_calls: [{
        id: "call-rec",
        type: "function",
        function: { name: "recommend_products", arguments: JSON.stringify({ product_ids: ["100350974"] }) },
      }],
    }));
    const result = await runAssistantTurn({
      messages: [{ role: "user", content: "coffee table under 400" }],
      warehouse: { id: "w1", name: "Brooklyn" },
    }, { fetch: fetchMock as unknown as typeof fetch, apiKey: "test-key" });
    expect(result.recommendations.every((item) => item.memberPrice <= 400)).toBe(true);
    expect(result.recommendations.some((item) => item.id === "100350974")).toBe(false);
    expect(result.recommendations.length).toBeGreaterThan(0);
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
