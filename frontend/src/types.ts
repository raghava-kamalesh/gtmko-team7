export type Warehouse = { id: string; name: string; city: string; state: string; zip: string; address: string };
export type ProductSpec = { name: string; value: string };
export type Product = {
  id: string; name: string; category: string; price: number; memberPrice?: number; compareAtPrice?: number;
  rating: number; reviews: number; image: string; badge?: string; description: string;
  stockByWarehouse: Record<string, number>; brand?: string; sku?: string; specs?: ProductSpec[]; featured?: boolean;
  dietaryTags?: string[]; packSize?: string | null; memberOnly?: boolean;
};
export type KirkSuggestion = {
  id: string; label: string; prompt: string; reason: string; heroUrl: string; heroSource?: string;
};
export type KirkNotification = {
  id: string; memberKey: string; title: string; body: string; itemId?: string | null; read: boolean; createdAt: string;
};
export type KirkPreorderItem = {
  id: string; name: string; category?: string | null; vendor?: string | null; description?: string | null; available: boolean;
};
export type KirkHome = {
  member: { key: string; displayName: string; email?: string | null; unmetInterests: Array<{ text: string; category: string }>; history: string[] };
  suggestions: KirkSuggestion[];
  preorderItems: KirkPreorderItem[];
  notifications: KirkNotification[];
};
export type CartItem = { productId: string; quantity: number };
export type User = { id: string; email: string; name: string; membershipNumber?: string };
export type Shipping = { name: string; address: string; city: string; state: string; zip: string };
export type Order = {
  id: string; createdAt: string; status: string; items: CartItem[]; total: number; shipping: Shipping;
  returnStatus?: string;
};
