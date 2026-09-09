import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { getStorefrontCatalog } from "./storefront-catalog.js";

const VOICE_URL = "wss://api.x.ai/v1/realtime";
const VOICE_MODEL = "grok-voice-latest";

export function kirkVoiceInstructions(warehouse: { id: string; name: string }, cartSummary: string): string {
  const sample = getStorefrontCatalog().slice(0, 8).map((item) => `${item.id} ${item.name}`).join("; ");
  return [
    "You are Kirk, the Costco warehouse shopping assistant.",
    `The member's warehouse is ${warehouse.name} (id ${warehouse.id}).`,
    "Recommend only catalog items. Mention member price and stock when you know them.",
    "You can add items to the cart with add_to_cart, summarize the cart, and capture unmet demand when nothing fits.",
    "If the member wants a visual of the cart, tell them to tap Imagine spread in the Kirk panel.",
    cartSummary ? `Current cart: ${cartSummary}` : "The cart is empty.",
    `Example catalog ids: ${sample}`,
  ].join(" ");
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
      description: "Store an unmet product request when the catalog cannot fulfill it",
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
  const upstreamUrl = `${process.env.XAI_VOICE_URL ?? VOICE_URL}?model=${encodeURIComponent(model)}${conversationId ? `&conversation_id=${encodeURIComponent(conversationId)}` : ""}`;
  const upstream = new WebSocket(upstreamUrl, { headers: { Authorization: `Bearer ${apiKey}` } });

  const forward = (from: WebSocket, to: WebSocket) => {
    from.on("message", (data, isBinary) => {
      if (to.readyState === WebSocket.OPEN) to.send(data, { binary: isBinary });
    });
    from.on("close", (code, reason) => {
      if (to.readyState === WebSocket.OPEN) to.close(code, reason.toString());
    });
    from.on("error", () => {
      if (to.readyState === WebSocket.OPEN) to.close(1011, "voice_proxy_error");
    });
  };

  upstream.on("open", () => {
    client.send(JSON.stringify({ type: "proxy.ready", model }));
  });
  upstream.on("error", () => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: "error",
        error: { code: "GROK_VOICE_ERROR", message: "Could not reach Grok Voice. Try again." },
      }));
    }
  });

  forward(client, upstream);
  forward(upstream, client);
}
