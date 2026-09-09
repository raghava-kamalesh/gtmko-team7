import {
  getCatalogById,
  searchStorefrontCatalog,
  summarizeMatch,
  withWarehouse,
  type CatalogMatch,
} from "./storefront-catalog.js";

export class AssistantError extends Error {
  constructor(
    readonly status: 400 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AssistantTurnInput = {
  messages: ChatMessage[];
  warehouse: { id: string; name: string };
};

export type RecommendedProduct = {
  id: string;
  name: string;
  brand: string;
  memberPrice: number;
  category: string;
  inStock: boolean;
};

export type AssistantTurnResult = {
  reply: string;
  recommendations: RecommendedProduct[];
  askToView: boolean;
};

type GrokToolCall = {
  id: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

type GrokMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: GrokToolCall[];
};

type GrokResponse = {
  choices?: Array<{ message?: GrokMessage }>;
  error?: { message?: string };
};

const XAI_CHAT_URL = "https://api.x.ai/v1/chat/completions";
const DEFAULT_MODEL = "grok-4.20-0309-non-reasoning";
const MAX_TOOL_ROUNDS = 4;

const tools = [
  {
    type: "function",
    function: {
      name: "search_catalog",
      description: "Search the Costco demo catalog. Call this before recommending items if the seeded matches are not enough.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Product, brand, or use-case search text" },
          category: {
            type: "string",
            enum: ["grocery", "household", "electronics", "furniture", "clothing", "outdoor", "auto", "services"],
          },
          limit: { type: "integer", minimum: 1, maximum: 8 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recommend_products",
      description: "Declare the storefront product ids you are recommending. Use only ids from catalog matches or search_catalog results.",
      parameters: {
        type: "object",
        properties: {
          product_ids: {
            type: "array",
            items: { type: "string" },
            description: "One to three storefront product ids",
          },
        },
        required: ["product_ids"],
      },
    },
  },
];

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const record = part as Record<string, unknown>;
        if (typeof record.text === "string") return record.text;
        if (typeof record.content === "string") return record.content;
      }
      return "";
    })
    .join("");
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function toRecommendation(match: CatalogMatch): RecommendedProduct {
  return {
    id: match.id,
    name: match.name,
    brand: match.brand,
    memberPrice: match.memberPrice,
    category: match.category,
    inStock: match.inStock,
  };
}

function resolveIds(ids: string[], warehouseId: string): CatalogMatch[] {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  return unique
    .map((id) => getCatalogById(id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .map((item) => withWarehouse(item, warehouseId))
    .slice(0, 3);
}

function inferFromText(text: string, candidates: CatalogMatch[]): CatalogMatch[] {
  const lower = text.toLowerCase();
  return candidates
    .filter((item) => {
      if (lower.includes(item.id.toLowerCase())) return true;
      const name = item.name.toLowerCase();
      return name.length > 12 && lower.includes(name.slice(0, 24));
    })
    .slice(0, 3);
}

function systemPrompt(warehouse: { id: string; name: string }, matches: CatalogMatch[]): string {
  const lines = matches.map((item) => (
    `- id=${item.id} | ${item.name} | ${item.brand} | $${item.memberPrice.toFixed(2)} | ${item.inStock ? `${item.quantity} in stock` : "out of stock"} at ${warehouse.name}`
  ));
  return [
    "You are the Costco digital shopping assistant for this demo storefront.",
    "Recommend only products that appear in the catalog matches or search_catalog results. Never invent items, prices, or ids.",
    `The member's selected warehouse is ${warehouse.name} (id ${warehouse.id}). Use that stock when you mention availability.`,
    "When you recommend one or more products, call recommend_products with those ids.",
    "After you recommend a product, ask if they would like to see the product page. Do not say you opened it yourself.",
    "Keep replies concise and conversational. Mention member price and warehouse stock when you have them.",
    lines.length ? `Catalog matches for this turn:\n${lines.join("\n")}` : "No catalog matches were preselected. Use search_catalog.",
  ].join("\n\n");
}

async function complete(
  messages: unknown[],
  deps: { fetch: typeof fetch; apiKey: string; model: string; apiUrl: string },
): Promise<GrokMessage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await deps.fetch(deps.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: deps.model,
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0.4,
        max_tokens: 700,
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null) as GrokResponse | null;
    if (!response.ok) {
      console.error("Grok request failed", response.status, payload?.error?.message ?? payload);
      throw new AssistantError(502, "GROK_ERROR", "The assistant could not complete this reply");
    }
    const message = payload?.choices?.[0]?.message;
    if (!message) throw new AssistantError(502, "GROK_ERROR", "The assistant returned an empty reply");
    return message;
  } catch (error) {
    if (error instanceof AssistantError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new AssistantError(502, "GROK_TIMEOUT", "The assistant took too long to reply");
    }
    throw new AssistantError(502, "GROK_ERROR", "The assistant could not complete this reply");
  } finally {
    clearTimeout(timer);
  }
}

export async function runAssistantTurn(
  input: AssistantTurnInput,
  deps: {
    fetch?: typeof fetch;
    apiKey?: string;
    model?: string;
    apiUrl?: string;
  } = {},
): Promise<AssistantTurnResult> {
  const apiKey = deps.apiKey ?? process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new AssistantError(503, "GROK_NOT_CONFIGURED", "The assistant is not configured. Set XAI_API_KEY on the API server.");
  }
  const last = input.messages.at(-1);
  if (!last || last.role !== "user") {
    throw new AssistantError(400, "VALIDATION_ERROR", "The last message must come from the user");
  }
  const warehouseId = input.warehouse.id || "w1";
  const seeded = searchStorefrontCatalog(last.content, { warehouseId, limit: 6 });
  const grokMessages: unknown[] = [
    { role: "system", content: systemPrompt(input.warehouse, seeded) },
    ...input.messages.map((message) => ({ role: message.role, content: message.content })),
  ];
  const recommended: CatalogMatch[] = [];
  let reply = "";
  const runtime = {
    fetch: deps.fetch ?? fetch,
    apiKey,
    model: deps.model ?? process.env.XAI_MODEL ?? DEFAULT_MODEL,
    apiUrl: deps.apiUrl ?? process.env.XAI_API_URL ?? XAI_CHAT_URL,
  };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const message = await complete(grokMessages, runtime);
    const content = textFromContent(message.content).trim();
    if (content) reply = content;
    const calls = message.tool_calls ?? [];
    if (!calls.length) break;
    grokMessages.push({
      role: "assistant",
      content: message.content ?? "",
      tool_calls: calls,
    });
    for (const call of calls) {
      const name = call.function?.name ?? "";
      const args = parseArgs(call.function?.arguments);
      let output: unknown = { error: `Unknown tool ${name}` };
      if (name === "search_catalog") {
        const query = String(args.query ?? last.content);
        const category = typeof args.category === "string" ? args.category : undefined;
        const limit = typeof args.limit === "number" ? args.limit : 6;
        output = searchStorefrontCatalog(query, { category, limit, warehouseId }).map(summarizeMatch);
      } else if (name === "recommend_products") {
        const ids = Array.isArray(args.product_ids) ? args.product_ids.map((id) => String(id)) : [];
        const resolved = resolveIds(ids, warehouseId);
        recommended.push(...resolved);
        output = { ok: true, products: resolved.map(summarizeMatch) };
      }
      grokMessages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
    }
    if (reply && recommended.length) break;
  }

  const inferred = recommended.length ? recommended : inferFromText(reply, seeded);
  const unique = [...new Map(inferred.map((item) => [item.id, item])).values()].slice(0, 3);
  if (!reply) {
    if (unique[0]) {
      const first = unique[0];
      reply = `${first.name} is $${first.memberPrice.toFixed(2)} and ${first.inStock ? `in stock at ${input.warehouse.name}` : `unavailable at ${input.warehouse.name}`}. Would you like to see the product page?`;
    } else {
      reply = "I can recommend items from this warehouse catalog. Tell me what you need — a TV size, household staple, or furniture piece.";
    }
  }
  return {
    reply,
    recommendations: unique.map(toRecommendation),
    askToView: unique.length > 0,
  };
}
