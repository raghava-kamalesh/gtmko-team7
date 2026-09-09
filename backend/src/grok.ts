import {
  inferDietaryTags,
  inferMemberOnly,
  inferPackSize,
} from "./catalog-meta.js";
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

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  image?: { mimeType: string; data: string };
};

export type AssistantCartLine = { productId: string; name?: string; brand?: string; quantity: number };

export type AssistantTurnInput = {
  messages: ChatMessage[];
  warehouse: { id: string; name: string };
  cart?: AssistantCartLine[];
  memberKey?: string;
};

export type RecommendedProduct = {
  id: string;
  name: string;
  brand: string;
  memberPrice: number;
  category: string;
  inStock: boolean;
  dietaryTags: string[];
  packSize: string | null;
  memberOnly: boolean;
};

export type CartAction = { productId: string; quantity: number };

export type UnmetDemandCapture = { rawText: string; category?: string; attributes?: Record<string, unknown> };

export type AssistantTurnResult = {
  reply: string;
  recommendations: RecommendedProduct[];
  askToView: boolean;
  cartActions: CartAction[];
  unmetDemand: UnmetDemandCapture | null;
  cartSummary: { itemCount: number; lines: AssistantCartLine[] } | null;
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
const DEFAULT_MODEL = "grok-4.6";
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
  {
    type: "function",
    function: {
      name: "add_to_cart",
      description: "Add a recommended catalog product to the member cart.",
      parameters: {
        type: "object",
        properties: {
          product_id: { type: "string" },
          quantity: { type: "integer", minimum: 1, maximum: 12 },
        },
        required: ["product_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "capture_unmet_demand",
      description: "Call when the member wanted something the catalog cannot fulfill (nothing fits, looking for X).",
      parameters: {
        type: "object",
        properties: {
          raw_text: { type: "string" },
          category: { type: "string" },
          attributes: { type: "object" },
        },
        required: ["raw_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_cart_summary",
      description: "Show the current cart when the member asks what is in it or after adding items.",
      parameters: { type: "object", properties: {} },
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
    dietaryTags: inferDietaryTags(match.name, match.description, match.brand),
    packSize: inferPackSize(match.name),
    memberOnly: inferMemberOnly(match.brand),
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

function systemPrompt(
  warehouse: { id: string; name: string },
  matches: CatalogMatch[],
  cart: AssistantCartLine[] = [],
): string {
  const lines = matches.map((item) => (
    `- id=${item.id} | ${item.name} | ${item.brand} | $${item.memberPrice.toFixed(2)} | ${item.inStock ? `${item.quantity} in stock` : "out of stock"} at ${warehouse.name}`
  ));
  const cartLines = cart.map((item) => `- ${item.quantity}× ${item.name ?? item.productId}`);
  return [
    "You are Kirk, the Costco warehouse shopping assistant for this demo storefront.",
    "Recommend only products that appear in the catalog matches or search_catalog results. Never invent items, prices, or ids.",
    `The member's selected warehouse is ${warehouse.name} (id ${warehouse.id}). Use that stock when you mention availability.`,
    "Honor constraints: budget, party size, diet tags, Kirkland-first, pack size, and warehouse stock.",
    "When you recommend one or more products, call recommend_products with those ids.",
    "When the member wants to buy a recommended item, call add_to_cart.",
    "If nothing fits or they were looking for something else, call capture_unmet_demand. Out-of-stock weak matches can also lead there.",
    "When they ask about the cart, call show_cart_summary.",
    "After you recommend a product, ask if they would like to see the product page or add it to the cart. Do not say you opened it yourself.",
    "Keep replies concise and conversational. Mention member price and warehouse stock when you have them.",
    "If the user sent a photo, infer the scene (pantry, recipe, snack table, product) and recommend complements from the catalog.",
    cartLines.length ? `Current cart:\n${cartLines.join("\n")}` : "The cart is empty.",
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
  const searchText = last.image ? `${last.content} pantry recipe snack table product photo` : last.content;
  const seeded = searchStorefrontCatalog(searchText, { warehouseId, limit: 6 });
  const grokMessages: unknown[] = [
    { role: "system", content: systemPrompt(input.warehouse, seeded, input.cart ?? []) },
    ...input.messages.map((message) => ({
      role: message.role,
      content: message.image
        ? [
            { type: "text", text: message.content },
            { type: "image_url", image_url: { url: `data:${message.image.mimeType};base64,${message.image.data}` } },
          ]
        : message.content,
    })),
  ];
  const recommended: CatalogMatch[] = [];
  const cartActions: CartAction[] = [];
  let unmetDemand: UnmetDemandCapture | null = null;
  let showCart = false;
  let reply = "";
  const runtime = {
    fetch: deps.fetch ?? fetch,
    apiKey,
    model: deps.model ?? process.env.XAI_MODEL ?? DEFAULT_MODEL,
    apiUrl: deps.apiUrl ?? process.env.XAI_API_URL ?? XAI_CHAT_URL,
  };

  try {
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
        } else if (name === "add_to_cart") {
          const productId = String(args.product_id ?? "");
          const quantity = typeof args.quantity === "number" ? Math.max(1, Math.min(12, args.quantity)) : 1;
          const resolved = resolveIds([productId], warehouseId);
          if (resolved[0]) {
            recommended.push(resolved[0]);
            cartActions.push({ productId: resolved[0].id, quantity });
            output = { ok: true, added: summarizeMatch(resolved[0]), quantity };
          } else {
            output = { ok: false, error: "Unknown product id" };
          }
        } else if (name === "capture_unmet_demand") {
          unmetDemand = {
            rawText: String(args.raw_text ?? last.content),
            category: typeof args.category === "string" ? args.category : undefined,
            attributes: args.attributes && typeof args.attributes === "object" ? args.attributes as Record<string, unknown> : undefined,
          };
          output = { ok: true, queued: true };
        } else if (name === "show_cart_summary") {
          showCart = true;
          output = { ok: true, cart: input.cart ?? [] };
        }
        grokMessages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
      }
      if (reply && recommended.length) break;
    }
  } catch (error) {
    // Restricted clouds often block api.x.ai; keep Kirk usable from the local catalog.
    if (error instanceof AssistantError && (error.code === "GROK_ERROR" || error.code === "GROK_TIMEOUT")) {
      return catalogFallbackTurn(input, last, seeded);
    }
    throw error;
  }

  return assembleTurn(input, last, seeded, { reply, recommended, cartActions, unmetDemand, showCart });
}

function looksUnmet(text: string): boolean {
  return /i was actually looking|nothing (fits|matches)|you don'?t have|not what i (wanted|meant)|wanted something else/i.test(text);
}

function looksBuyIntent(text: string): boolean {
  return /\b(add|put)\b.+\b(cart|basket)\b|\badd (the|it|this|those|a|an)\b|\bi('ll| will) take\b/i.test(text);
}

function looksCartQuestion(text: string): boolean {
  return /\b(show|what'?s|what is|view|see)\b.+\bcart\b|\bmy cart\b/i.test(text);
}

function assembleTurn(
  input: AssistantTurnInput,
  last: ChatMessage,
  seeded: CatalogMatch[],
  state: {
    reply: string;
    recommended: CatalogMatch[];
    cartActions: CartAction[];
    unmetDemand: UnmetDemandCapture | null;
    showCart: boolean;
  },
): AssistantTurnResult {
  const inferred = state.recommended.length ? state.recommended : inferFromText(state.reply, seeded);
  const unique = [...new Map(inferred.map((item) => [item.id, item])).values()].slice(0, 3);
  let unmetDemand = state.unmetDemand;
  if (!unmetDemand && looksUnmet(last.content) && !unique.length) {
    unmetDemand = { rawText: last.content };
  }
  let reply = state.reply;
  if (!reply) {
    if (unique[0]) {
      const first = unique[0];
      reply = `${first.name} is $${first.memberPrice.toFixed(2)} and ${first.inStock ? `in stock at ${input.warehouse.name}` : `unavailable at ${input.warehouse.name}`}. Would you like to see the product page?`;
    } else if (unmetDemand) {
      reply = "I do not have a strong catalog match. I logged that as unmet demand so merch can source it. You will get a preorder notice if it is approved.";
    } else {
      reply = "I can recommend items from this warehouse catalog. Tell me what you need — a TV size, household staple, or furniture piece.";
    }
  }
  return {
    reply,
    recommendations: unique.map(toRecommendation),
    askToView: unique.length > 0,
    cartActions: state.cartActions,
    unmetDemand,
    cartSummary: state.showCart || state.cartActions.length
      ? { itemCount: (input.cart ?? []).reduce((n, line) => n + line.quantity, 0), lines: input.cart ?? [] }
      : null,
  };
}

function catalogFallbackTurn(
  input: AssistantTurnInput,
  last: ChatMessage,
  seeded: CatalogMatch[],
): AssistantTurnResult {
  const inStock = seeded.filter((item) => item.inStock);
  const picks = (inStock.length ? inStock : seeded).slice(0, 3);
  return assembleTurn(input, last, seeded, {
    reply: "",
    recommended: picks,
    cartActions: looksBuyIntent(last.content) && picks[0] ? [{ productId: picks[0].id, quantity: 1 }] : [],
    unmetDemand: looksUnmet(last.content) && !picks.length ? { rawText: last.content } : null,
    showCart: looksCartQuestion(last.content),
  });
}
