export type Warehouse = { id: string; name: string; city: string; state: string; zip: string; address: string };
export type ProductSpec = { name: string; value: string };
export type Product = {
  id: string; name: string; category: string; price: number; memberPrice?: number; compareAtPrice?: number;
  rating: number; reviews: number; image: string; badge?: string; description: string;
  stockByWarehouse: Record<string, number>; brand?: string; sku?: string; specs?: ProductSpec[]; featured?: boolean;
};
export type CartItem = { productId: string; quantity: number };
export type User = { id: string; email: string; name: string; membershipNumber?: string };
export type Shipping = { name: string; address: string; city: string; state: string; zip: string };
export type Order = {
  id: string; createdAt: string; status: string; items: CartItem[]; total: number; shipping: Shipping;
  returnStatus?: string;
};
