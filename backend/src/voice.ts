import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import {
  getCatalogById,
  getStorefrontCatalog,
  searchStorefrontCatalog,
  summarizeMatch,
  withWarehouse,
} from "./storefront-catalog.js";

const VOICE_URL = "wss://api.x.ai/v1/realtime";
const VOICE_MODEL = "grok-voice-latest";

export function kirkVoiceInstructions(warehouse: { id: string; name: string }, cartSummary: string): string {
  const sample = getStorefrontCatalog().slice(0, 8).map((item) => `${item.id} ${item.name}`).join("; ");
  return [
    "You are Kirk, the Costco warehouse shopping assistant.",
    "This is a live spoken conversation. Answer out loud, briefly, then keep listening.",
    `The member's warehouse is ${warehouse.name} (id ${warehouse.id}).`,
    "When they ask for a product, call search_catalog, then recommend_products with matching ids so the storefront can show cards.",
    "Recommend only catalog items. Mention member price and stock when you know them.",
    "You can add items to the cart with add_to_cart, and capture unmet demand only after they agree to request a missing product.",
    cartSummary ? `Current cart: ${cartSummary}` : "The cart is empty.",
    `Example catalog ids: ${sample}`,
  ].join(" ");
}

export function executeVoiceTool(
  name: string,
  args: Record<string, unknown>,
  warehouseId: string,
): { output: unknown; productIds: string[] } {
  if (name === "search_catalog") {
    const matches = searchStorefrontCatalog(String(args.query ?? ""), {
      category: typeof args.category === "string" ? args.category : undefined,
      limit: typeof args.limit === "number" ? args.limit : 6,
      warehouseId,
    });
    return { output: matches.map(summarizeMatch), productIds: matches.slice(0, 3).map((item) => item.id) };
  }
  if (name === "recommend_products") {
    const ids = Array.isArray(args.product_ids) ? args.product_ids.map((id) => String(id)) : [];
    const resolved = ids
      .map((id) => getCatalogById(id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .map((item) => withWarehouse(item, warehouseId))
      .slice(0, 3);
    return { output: { ok: true, products: resolved.map(summarizeMatch) }, productIds: resolved.map((item) => item.id) };
  }
  if (name === "add_to_cart") {
    const productId = String(args.product_id ?? "");
    return { output: { ok: true, product_id: productId }, productIds: productId ? [productId] : [] };
  }
  if (name === "capture_unmet_demand") {
    return { output: { ok: true, queued: true }, productIds: [] };
  }
  return { output: { error: `Unknown tool ${name}` }, productIds: [] };
}

export function kirkVoiceTools() {
  return [
    {
      type: "function",
      name: "search_catalog",
      description: "Search the warehouse catalog",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, category: { type: "string" }, limit: { type: "integer" } },
        required: ["query"],
      },
    },
    {
      type: "function",
      name: "recommend_products",
      description: "Recommend catalog product ids",
      parameters: {
        type: "object",
        properties: { product_ids: { type: "array", items: { type: "string" } } },
        required: ["product_ids"],
      },
    },
    {
      type: "function",
      name: "add_to_cart",
      description: "Add a catalog product to the member cart",
      parameters: {
        type: "object",
        properties: { product_id: { type: "string" }, quantity: { type: "integer" } },
        required: ["product_id"],
      },
    },
    {
      type: "function",
      name: "capture_unmet_demand",
      description: "Store an inventory request after the member agrees or describes a missing product",
      parameters: {
        type: "object",
        properties: { raw_text: { type: "string" }, category: { type: "string" } },
        required: ["raw_text"],
      },
    },
  ];
}

export function createVoiceSession(input: { warehouse: { id: string; name: string }; cartSummary?: string; conversationId?: string }) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return {
      configured: false,
      model: process.env.XAI_VOICE_MODEL ?? VOICE_MODEL,
      wsPath: "/assistant/voice/live",
      instructions: kirkVoiceInstructions(input.warehouse, input.cartSummary ?? ""),
      tools: kirkVoiceTools(),
    };
  }
  return {
    configured: true,
    model: process.env.XAI_VOICE_MODEL ?? VOICE_MODEL,
    wsPath: "/assistant/voice/live",
    conversationId: input.conversationId ?? null,
    voice: process.env.XAI_VOICE ?? "eve",
    instructions: kirkVoiceInstructions(input.warehouse, input.cartSummary ?? ""),
    tools: kirkVoiceTools(),
  };
}

/** ws rejects 1005/1006 and other reserved codes; forwarding them crashed the API. */
export function closableVoiceCode(code: number): number {
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  return 1011;
}

export function closeVoicePeer(socket: WebSocket, code: number, reason?: Buffer | string) {
  if (socket.readyState !== WebSocket.OPEN) return;
  const text = typeof reason === "string" ? reason : reason?.toString() ?? "";
  socket.close(closableVoiceCode(code), text.slice(0, 123));
}

export function attachVoiceProxy(server: Server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/assistant/voice/live") return;
    wss.handleUpgrade(request, socket, head, (client) => {
      void proxyVoiceSession(client, url);
    });
  });
}

async function proxyVoiceSession(client: WebSocket, url: URL) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    client.send(JSON.stringify({
      type: "error",
      error: { code: "GROK_NOT_CONFIGURED", message: "Live voice needs XAI_API_KEY on the API server." },
    }));
    client.close(1011, "GROK_NOT_CONFIGURED");
    return;
  }

  const model = process.env.XAI_VOICE_MODEL ?? VOICE_MODEL;
  const conversationId = url.searchParams.get("conversation_id");
  const warehouseId = url.searchParams.get("warehouse_id") || "w1";
  const upstreamUrl = `${process.env.XAI_VOICE_URL ?? VOICE_URL}?model=${encodeURIComponent(model)}${conversationId ? `&conversation_id=${encodeURIComponent(conversationId)}` : ""}`;
  const queued: Array<{ data: WebSocket.RawData; binary: boolean }> = [];
  const upstream = new WebSocket(upstreamUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
  console.log(`voice: connecting upstream model=${model}`);

  const sendUpstream = (data: WebSocket.RawData, binary: boolean) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary });
      return;
    }
    queued.push({ data, binary });
  };

  client.on("message", (data, isBinary) => sendUpstream(data, isBinary));
  client.on("close", (code, reason) => closeVoicePeer(upstream, code, reason));
  client.on("error", () => closeVoicePeer(upstream, 1011, "voice_proxy_error"));

  upstream.on("open", () => {
    console.log(`voice: upstream open queued=${queued.length}`);
    for (const item of queued) {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(item.data, { binary: item.binary });
    }
    queued.length = 0;
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "proxy.ready", model }));
    }
  });
  upstream.on("message", (data, isBinary) => {
    if (!isBinary) {
      const text = typeof data === "string" ? data : data.toString();
      try {
        const payload = JSON.parse(text) as Record<string, unknown>;
        if (payload.type === "response.function_call_arguments.done") {
          fulfillVoiceTool(upstream, client, payload, warehouseId);
        }
      } catch {
        // Forward non-JSON text as-is.
      }
    }
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("close", (code, reason) => {
    console.log(`voice: upstream close code=${code}`);
    closeVoicePeer(client, code, reason);
  });
  upstream.on("error", (error) => {
    console.log(`voice: upstream error ${error.message}`);
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: "error",
        error: { code: "GROK_VOICE_ERROR", message: "Could not reach Grok Voice. Try again." },
      }));
    }
    closeVoicePeer(client, 1011, "voice_proxy_error");
  });
}

function fulfillVoiceTool(
  upstream: WebSocket,
  client: WebSocket,
  payload: Record<string, unknown>,
  warehouseId: string,
) {
  const name = String(payload.name ?? payload.function_name ?? "");
  const callId = String(payload.call_id ?? payload.id ?? "");
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(String(payload.arguments ?? "{}")) as Record<string, unknown>; } catch { args = {}; }
  const result = executeVoiceTool(name, args, warehouseId);
  if (upstream.readyState === WebSocket.OPEN && callId) {
    upstream.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result.output) },
    }));
    upstream.send(JSON.stringify({ type: "response.create" }));
  }
  if (client.readyState === WebSocket.OPEN && result.productIds.length) {
    client.send(JSON.stringify({ type: "kirk.products", productIds: result.productIds }));
  }
}
