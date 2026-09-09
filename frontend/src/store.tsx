import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { products, warehouses } from "./data";
import type { CartItem, Order, Product, Shipping, User, Warehouse } from "./types";

type Store = {
  products: Product[]; user: User | null; cart: CartItem[]; warehouse: Warehouse; deliveryZip: string; orders: Order[];
  setWarehouse: (w: Warehouse) => void; setDeliveryZip: (z: string) => void; add: (id: string, q?: number) => void;
  setQuantity: (id: string, q: number) => void; cartCount: number; cartTotal: number;
  login: (email: string, name?: string) => void; logout: () => void; register: (email: string, name: string) => void;
  placeOrder: (shipping: Shipping) => Order; returnOrder: (id: string) => void;
};
const StoreContext = createContext<Store | null>(null);
const read = <T,>(key: string, fallback: T): T => {
  try { return JSON.parse(localStorage.getItem(key) || "") as T; } catch { return fallback; }
};

export function StoreProvider({ children }: { children: ReactNode }) {
  const [cart, setCart] = useState<CartItem[]>(() => read("costco-cart", []));
  const [user, setUser] = useState<User | null>(() => read("costco-user", null));
  const [warehouse, updateWarehouse] = useState<Warehouse>(() => read("costco-warehouse", warehouses[0]));
  const [deliveryZip, updateZip] = useState(() => read("costco-zip", "11232"));
  const [orders, setOrders] = useState<Order[]>(() => read("costco-orders", []));
  useEffect(() => localStorage.setItem("costco-cart", JSON.stringify(cart)), [cart]);
  useEffect(() => localStorage.setItem("costco-orders", JSON.stringify(orders)), [orders]);
  const setWarehouse = (w: Warehouse) => { updateWarehouse(w); localStorage.setItem("costco-warehouse", JSON.stringify(w)); };
  const setDeliveryZip = (z: string) => { updateZip(z); localStorage.setItem("costco-zip", JSON.stringify(z)); };
  const setQuantity = (id: string, q: number) => setCart(c => q <= 0 ? c.filter(i => i.productId !== id) : c.map(i => i.productId === id ? { ...i, quantity: q } : i));
  const add = (id: string, q = 1) => setCart(c => c.some(i => i.productId === id) ? c.map(i => i.productId === id ? { ...i, quantity: i.quantity + q } : i) : [...c, { productId: id, quantity: q }]);
  const login = (email: string, name = email.split("@")[0]) => {
    const next = { id: "demo-user", email, name }; setUser(next); localStorage.setItem("costco-user", JSON.stringify(next));
  };
  const register = (email: string, name: string) => login(email, name);
  const logout = () => { setUser(null); localStorage.removeItem("costco-user"); };
  const cartTotal = cart.reduce((sum, item) => sum + (products.find(p => p.id === item.productId)?.memberPrice || 0) * item.quantity, 0);
  const placeOrder = (shipping: Shipping) => {
    const order: Order = { id: `ORD-${Date.now().toString().slice(-8)}`, createdAt: new Date().toISOString(), status: "Order received", items: cart, total: cartTotal, shipping };
    setOrders(o => [order, ...o]); setCart([]); return order;
  };
  const returnOrder = (id: string) => setOrders(o => o.map(order => order.id === id ? { ...order, returnStatus: "Return requested" } : order));
  const value = useMemo(() => ({ products, user, cart, warehouse, deliveryZip, orders, setWarehouse, setDeliveryZip, add, setQuantity,
    cartCount: cart.reduce((n, i) => n + i.quantity, 0), cartTotal, login, logout, register, placeOrder, returnOrder
  }), [user, cart, warehouse, deliveryZip, orders, cartTotal]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}
export const useStore = () => {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore requires StoreProvider");
  return store;
};
