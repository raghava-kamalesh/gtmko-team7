const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

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
};
export type AssistantChatResponse = {
  reply: string; recommendations: AssistantRecommendation[]; askToView: boolean;
};

export function sendAssistantChat(body: {
  messages: AssistantChatMessage[];
  warehouse: { id: string; name: string };
}) {
  return api<AssistantChatResponse>("/api/assistant/chat", { method: "POST", body: JSON.stringify(body) });
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
