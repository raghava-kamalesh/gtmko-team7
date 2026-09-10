// Same-origin /api so typed chat uses the Vite proxy, matching Grok Voice.
const BASE_URL = import.meta.env.VITE_API_URL ?? "";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function urlFor(path: string) {
  if (BASE_URL && path.startsWith("/api/")) return `${BASE_URL}${path.slice(4)}`;
  return `${BASE_URL}${path}`;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("costco-staff-token");
  const headers = new Headers(init?.headers);
  if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(urlFor(path), {
    credentials: "include",
    ...init,
    headers,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body?.error?.message || body?.message || "Request failed");
  return (body?.data ?? body) as T;
}

export type AssistantChatMessage = { role: "user" | "assistant"; content: string };
export type AssistantRecommendation = {
  id: string; name: string; brand: string; memberPrice: number; category: string; inStock: boolean;
  dietaryTags?: string[]; packSize?: string | null; memberOnly?: boolean;
};
export type AssistantChatResponse = {
  reply: string;
  recommendations: AssistantRecommendation[];
  askToView: boolean;
  askToRequestInventory?: boolean;
  cartActions?: Array<{ productId: string; quantity: number }>;
  unmetDemand?: { rawText: string; category?: string } | null;
  cartSummary?: { itemCount: number } | null;
  imagineUrl?: string;
};

export function sendAssistantChat(body: {
  messages: AssistantChatMessage[];
  warehouse: { id: string; name: string };
  cart?: Array<{ productId: string; name?: string; brand?: string; quantity: number }>;
  memberKey?: string;
  image?: { mimeType: string; data: string };
}) {
  return api<AssistantChatResponse>("/api/assistant/chat", { method: "POST", body: JSON.stringify(body) });
}

export function getKirkHome(memberKey?: string) {
  const query = memberKey ? `?memberKey=${encodeURIComponent(memberKey)}` : "";
  return api<import("./types").KirkHome>(`/api/kirk/home${query}`);
}

export function submitKirkFeedback(body: { type: "bug" | "wish" | "interaction"; details: string; transcript: unknown; memberKey?: string }) {
  return api<{ id: string; linearIdentifier: string | null; status: string; summary: string | null }>("/api/kirk/feedback", {
    method: "POST", body: JSON.stringify(body),
  });
}

export function captureKirkDemand(body: { rawText: string; category?: string; memberKey?: string }) {
  return api<{ request: { id: string; status: string } }>("/api/kirk/demand", { method: "POST", body: JSON.stringify(body) });
}

export function ensureKirkProductImages(ids: string[]) {
  return api<Array<{ productId: string; url: string; source: string; cached: boolean }>>("/api/kirk/product-images", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

export function imagineCart(cart: Array<{ productId: string; name?: string; brand?: string; imageUrl?: string; quantity: number }>) {
  return api<{ url: string; source: string; prompt: string }>("/api/assistant/imagine", {
    method: "POST", body: JSON.stringify({ kind: "cart_spread", cart }),
  });
}

export function createVoiceSession(body: { warehouse: { id: string; name: string }; cartSummary?: string; conversationId?: string }) {
  return api<{ configured: boolean; wsPath: string; instructions: string; tools: unknown[]; voice?: string; model: string }>(
    "/api/assistant/voice/session", { method: "POST", body: JSON.stringify(body) },
  );
}

export function listKirkPurchases() {
  return api<Array<{
    id: string; query: string; status: string; category: string | null;
    trends: Array<{ title?: string }>; vendors: Array<{ name?: string }>;
    memberKey: string; preorderItems: Array<{ id: string; name: string }>;
  }>>("/api/admin/kirk/purchases");
}

export function decideKirkPurchase(id: string, action: "approve" | "reject") {
  return api<{ request: { status: string }; preorderItem: { id: string; name: string } | null }>(
    `/api/admin/kirk/purchases/${id}/decide`, { method: "POST", body: JSON.stringify({ action }) },
  );
}

export function placeKirkPreorder(itemId: string, memberKey?: string) {
  return api<{ preorder: { id: string }; item: { name: string } }>("/api/kirk/preorders", {
    method: "POST", body: JSON.stringify({ itemId, memberKey }),
  });
}

export function markKirkNotificationRead(id: string) {
  return api(`/api/kirk/notifications/${id}/read`, { method: "POST" });
}

export function regenerateKirkHeroes() {
  return api("/api/kirk/heroes/regenerate", { method: "POST" });
}

export const endpoints = {
  warehouses: (query = "") => `/api/warehouses?query=${encodeURIComponent(query)}`,
  categories: "/api/categories",
  products: (params: URLSearchParams) => `/api/products?${params}`,
  product: (id: string, params: URLSearchParams) => `/api/products/${id}?${params}`,
  login: "/api/auth/login", register: "/api/auth/register", logout: "/api/auth/logout",
  me: "/api/me", cart: "/api/cart", orders: "/api/orders",
  order: (id: string) => `/api/orders/${id}`,
  returns: (id: string) => `/api/orders/${id}/returns`,
  staffLogin: "/api/auth/staff-login",
  adminOverview: "/api/admin/overview",
  adminInventory: "/api/admin/inventory",
  adminOrders: "/api/admin/orders",
  adminReturns: "/api/admin/returns",
  adminDiscounts: "/api/admin/discounts",
};
