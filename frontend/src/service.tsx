import { createContext, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, NavLink, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "./api";
import { Logo } from "./components";

type Staff = { id: string; email: string; name: string };
type Overview = {
  openOrders: number; deliveredOrders: number; orderCount: number; pendingReturns: number;
  returnCount: number; lowStock: number; outOfStock: number; unitsOnHand: number; activeDiscounts: number;
  recentOrders: OpsOrder[];
};
type StockRow = {
  id: string; quantity: number; aisle: string | null; sku: string; name: string;
  warehouseId: string; warehouseName: string; warehouseCity: string; warehouseState: string;
  lowStock: boolean; outOfStock: boolean;
};
type OpsOrder = {
  id: string; orderNumber: string; status: string; fulfillmentType: string; subtotal: number;
  tax: number; discount: number; total: number; placedAt: string;
  member: { email: string; name: string; membershipNumber: string | null } | null;
  warehouse: { name: string; city: string; state: string } | null;
  items?: Array<{ id: string; name: string; sku: string; quantity: number; unitPrice: number }>;
  discounts?: Array<{ id: string; amount: number; reason: string; discountName: string; discountCode: string | null }>;
};
type OpsReturn = {
  id: string; returnNumber: string; status: string; type: string; method: string; reason: string;
  orderNumber: string; memberEmail: string;
};
type OpsDiscount = {
  id: string; code: string | null; name: string; type: string; value: number; reason: string;
  status: string; usedCount: number; maxUses: number | null; notes: string | null;
};
type Warehouse = { id: string; name: string; city: string; state: string };

const staffKey = "costco-staff";
const tokenKey = "costco-staff-token";
const orderStatuses = ["processing", "readying_for_pickup", "shipped", "delivered", "cancelled"];
const returnStatuses = ["requested", "label_created", "received", "approved", "completed", "rejected", "cancelled"];
const money = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD" });
const title = (value: string) => value.replaceAll("_", " ");
const readStaff = (): Staff | null => {
  try { return JSON.parse(localStorage.getItem(staffKey) || ""); } catch { return null; }
};

const Ctx = createContext<{ staff: Staff | null; login: (s: Staff, t: string) => void; logout: () => void } | null>(null);
const useService = () => {
  const value = useContext(Ctx);
  if (!value) throw new Error("Service context missing");
  return value;
};

function ServiceRoot({ children }: { children: ReactNode }) {
  const [staff, setStaff] = useState<Staff | null>(readStaff);
  const login = (next: Staff, token: string) => {
    setStaff(next);
    localStorage.setItem(staffKey, JSON.stringify(next));
    localStorage.setItem(tokenKey, token);
  };
  const logout = () => {
    setStaff(null);
    localStorage.removeItem(staffKey);
    localStorage.removeItem(tokenKey);
  };
  const value = useMemo(() => ({ staff, login, logout }), [staff]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function RequireStaff({ children }: { children: ReactNode }) {
  const { staff } = useService();
  return staff ? children : <Navigate to="/service" replace />;
}

function statusClass(value: string) {
  if (["delivered", "completed", "active", "approved"].includes(value)) return "ops-pill success";
  if (["cancelled", "rejected", "expired", "revoked"].includes(value) || value.includes("out")) return "ops-pill danger";
  if (["low", "shipped", "received", "label_created"].includes(value)) return "ops-pill caution";
  return "ops-pill";
}

export function ServiceApp() {
  return <ServiceRoot><Routes>
    <Route index element={<ServiceLogin />} />
    <Route path="dashboard" element={<RequireStaff><ServiceShell><Dashboard /></ServiceShell></RequireStaff>} />
    <Route path="stock" element={<RequireStaff><ServiceShell><Stock /></ServiceShell></RequireStaff>} />
    <Route path="orders" element={<RequireStaff><ServiceShell><Orders /></ServiceShell></RequireStaff>} />
    <Route path="orders/:id" element={<RequireStaff><ServiceShell><OrderDetail /></ServiceShell></RequireStaff>} />
    <Route path="returns" element={<RequireStaff><ServiceShell><Returns /></ServiceShell></RequireStaff>} />
    <Route path="discounts" element={<RequireStaff><ServiceShell><Discounts /></ServiceShell></RequireStaff>} />
    <Route path="*" element={<div className="empty"><h1>Page not found</h1><Link to="/service">Back to customer service</Link></div>} />
  </Routes></ServiceRoot>;
}

function ServiceLogin() {
  const { staff, login } = useService();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  if (staff) return <Navigate to="/service/dashboard" replace />;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setPending(true);
    const form = new FormData(event.currentTarget);
    try {
      const payload = await api<{ token: string; member: { id: string; email: string; profile?: { firstName: string; lastName: string } | null } }>(
        "/api/auth/staff-login",
        { method: "POST", body: JSON.stringify({ email: String(form.get("email")), password: String(form.get("password")) }) },
      );
      const name = payload.member.profile ? `${payload.member.profile.firstName} ${payload.member.profile.lastName}` : payload.member.email;
      login({ id: payload.member.id, email: payload.member.email, name }, payload.token);
      navigate("/service/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to sign in to customer service.");
    } finally {
      setPending(false);
    }
  };
  return <div className="ops-login">
    <div className="ops-login-brand"><Logo /><p>Customer Service Operations</p></div>
    <div className="auth-card ops-login-card">
      <h1>Staff sign in</h1>
      <p>Manage warehouse stock, orders, returns, and discretionary discounts.</p>
      {error && <div className="alert" role="alert">{error}</div>}
      <form onSubmit={submit}>
        <label>Work email<input name="email" type="email" autoComplete="username" defaultValue="service@costco.demo" required /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" defaultValue="CostcoDemo123!" minLength={6} required /></label>
        <button className="primary big" disabled={pending}>{pending ? "Signing in…" : "Sign in to operations"}</button>
      </form>
      <small>Demo staff: service@costco.demo · CostcoDemo123!</small>
      <p><Link to="/">Return to storefront</Link></p>
    </div>
  </div>;
}

function ServiceShell({ children }: { children: ReactNode }) {
  const { staff, logout } = useService();
  const navigate = useNavigate();
  const links = [
    ["/service/dashboard", "Overview"],
    ["/service/stock", "Warehouse stock"],
    ["/service/orders", "Orders"],
    ["/service/returns", "Returns"],
    ["/service/discounts", "Discounts"],
  ] as const;
  return <div className="ops">
    <aside className="ops-side">
      <div className="ops-brand"><Logo /><b>Customer Service</b></div>
      <nav aria-label="Operations">
        {links.map(([href, label]) => <NavLink key={href} to={href} end={href.endsWith("dashboard")}>{label}</NavLink>)}
      </nav>
      <button className="secondary" onClick={() => { logout(); navigate("/service"); }}>Sign out</button>
    </aside>
    <div className="ops-main">
      <header className="ops-top">
        <span>Internal operations · Demo only</span>
        <b>{staff?.name}</b>
      </header>
      <div className="ops-content">{children}</div>
    </div>
  </div>;
}

function Dashboard() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api<Overview>("/api/admin/overview").then(setData).catch(err => setError(err.message)); }, []);
  if (error) return <div className="alert" role="alert">{error}</div>;
  if (!data) return <p className="ops-muted">Loading operations overview…</p>;
  const cards = [
    ["Open orders", data.openOrders, "Needs fulfillment"],
    ["Pending returns", data.pendingReturns, "Awaiting action"],
    ["Low stock SKUs", data.lowStock, `${data.outOfStock} out of stock`],
    ["Active discounts", data.activeDiscounts, `${data.unitsOnHand.toLocaleString()} units on hand`],
  ] as const;
  return <>
    <div className="ops-head"><h1>Operations overview</h1><p>Warehouse, order, return, and courtesy-discount queues.</p></div>
    <div className="ops-stats">{cards.map(([label, value, hint]) => <article key={label}><span>{label}</span><b>{value}</b><small>{hint}</small></article>)}</div>
    <section className="ops-panel">
      <div className="ops-panel-head"><h2>Recent orders</h2><Link to="/service/orders">View all</Link></div>
      <OrderTable orders={data.recentOrders} />
    </section>
  </>;
}

function Stock() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [rows, setRows] = useState<StockRow[]>([]);
  const [warehouseId, setWarehouseId] = useState("");
  const [query, setQuery] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [error, setError] = useState("");
  const load = () => {
    const params = new URLSearchParams({ pageSize: "40" });
    if (warehouseId) params.set("warehouseId", warehouseId);
    if (query) params.set("q", query);
    if (lowOnly) params.set("lowStock", "true");
    api<StockRow[]>(`/api/admin/inventory?${params}`).then(setRows).catch(err => setError(err.message));
  };
  useEffect(() => { api<Warehouse[]>("/api/warehouses").then(setWarehouses).catch(() => undefined); }, []);
  useEffect(() => { load(); }, [warehouseId, lowOnly]);
  const adjust = async (row: StockRow, quantity: number) => {
    try {
      await api(`/api/admin/inventory/${row.id}`, { method: "PATCH", body: JSON.stringify({ quantity }) });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update stock");
    }
  };
  return <>
    <div className="ops-head"><h1>Warehouse stock</h1><p>Adjust on-hand units by warehouse. Low stock is 8 units or fewer.</p></div>
    {error && <div className="alert" role="alert">{error}</div>}
    <form className="ops-toolbar" onSubmit={event => { event.preventDefault(); load(); }}>
      <label>Warehouse
        <select aria-label="Filter warehouse" value={warehouseId} onChange={e => setWarehouseId(e.target.value)}>
          <option value="">All warehouses</option>
          {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </label>
      <label>Search<input aria-label="Search stock" value={query} onChange={e => setQuery(e.target.value)} placeholder="SKU or product" /></label>
      <label className="ops-check"><input type="checkbox" checked={lowOnly} onChange={e => setLowOnly(e.target.checked)} /> Low stock only</label>
      <button className="primary" type="submit">Apply</button>
    </form>
    <div className="ops-table-wrap">
      <table className="ops-table">
        <thead><tr><th>Product</th><th>SKU</th><th>Warehouse</th><th>Aisle</th><th>On hand</th><th>Status</th><th>Adjust</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id}>
          <td><b>{row.name}</b></td><td>{row.sku}</td>
          <td>{row.warehouseName}<small>{row.warehouseCity}, {row.warehouseState}</small></td>
          <td>{row.aisle || "—"}</td><td>{row.quantity}</td>
          <td><span className={statusClass(row.outOfStock ? "out" : row.lowStock ? "low" : "active")}>{row.outOfStock ? "Out of stock" : row.lowStock ? "Low stock" : "In stock"}</span></td>
          <td className="ops-adjust">
            <button type="button" aria-label={`Decrease ${row.name}`} onClick={() => adjust(row, Math.max(0, row.quantity - 1))}>−</button>
            <button type="button" aria-label={`Increase ${row.name}`} onClick={() => adjust(row, row.quantity + 1)}>+</button>
          </td>
        </tr>)}</tbody>
      </table>
    </div>
  </>;
}

function Orders() {
  const [orders, setOrders] = useState<OpsOrder[]>([]);
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const load = () => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (query) params.set("q", query);
    api<OpsOrder[]>(`/api/admin/orders?${params}`).then(setOrders).catch(err => setError(err.message));
  };
  useEffect(() => { load(); }, [status]);
  return <>
    <div className="ops-head"><h1>Orders</h1><p>Update fulfillment status and apply courtesy discounts.</p></div>
    {error && <div className="alert" role="alert">{error}</div>}
    <form className="ops-toolbar" onSubmit={event => { event.preventDefault(); load(); }}>
      <label>Status
        <select aria-label="Filter order status" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {orderStatuses.map(value => <option key={value} value={value}>{title(value)}</option>)}
        </select>
      </label>
      <label>Search<input aria-label="Search orders" value={query} onChange={e => setQuery(e.target.value)} placeholder="Order number or member" /></label>
      <button className="primary" type="submit">Search</button>
    </form>
    <OrderTable orders={orders} />
  </>;
}

function OrderTable({ orders }: { orders: OpsOrder[] }) {
  return <div className="ops-table-wrap">
    <table className="ops-table">
      <thead><tr><th>Order</th><th>Member</th><th>Warehouse</th><th>Status</th><th>Total</th></tr></thead>
      <tbody>{orders.map(order => <tr key={order.id}>
        <td><Link to={`/service/orders/${order.id}`}><b>{order.orderNumber}</b></Link><small>{new Date(order.placedAt).toLocaleDateString()}</small></td>
        <td>{order.member?.name}<small>{order.member?.email}</small></td>
        <td>{order.warehouse?.name || "—"}</td>
        <td><span className={statusClass(order.status)}>{title(order.status)}</span></td>
        <td>{money(order.total)}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function OrderDetail() {
  const { id } = useParams();
  const [order, setOrder] = useState<OpsOrder | null>(null);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("15");
  const load = () => api<OpsOrder>(`/api/admin/orders/${id}`).then(setOrder).catch(err => setError(err.message));
  useEffect(() => { load(); }, [id]);
  if (error) return <div className="alert" role="alert">{error}</div>;
  if (!order) return <p className="ops-muted">Loading order…</p>;
  const updateStatus = async (status: string) => {
    try { setOrder(await api(`/api/admin/orders/${order.id}`, { method: "PATCH", body: JSON.stringify({ status }) })); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Could not update order"); }
  };
  const applyDiscount = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setOrder(await api(`/api/admin/orders/${order.id}/discounts`, {
        method: "POST",
        body: JSON.stringify({ type: "amount", value: Number(amount), reason, name: "Discretionary courtesy" }),
      }));
      setReason("");
    } catch (err) { setError(err instanceof ApiError ? err.message : "Could not apply discount"); }
  };
  return <>
    <div className="ops-head"><p className="ops-crumb"><Link to="/service/orders">Orders</Link> / {order.orderNumber}</p><h1>{order.orderNumber}</h1></div>
    <div className="ops-split">
      <section className="ops-panel">
        <div className="notice"><b>{title(order.status)}</b><span>{order.member?.name} · {order.member?.email}</span></div>
        {(order.items || []).map(item => <div className="mini-line" key={item.id}><span>{item.name}<small>{item.sku} · Qty {item.quantity}</small></span><b>{money(item.unitPrice * item.quantity)}</b></div>)}
        <p className="total"><span>Subtotal</span><b>{money(order.subtotal)}</b></p>
        <p className="total"><span>Tax</span><b>{money(order.tax)}</b></p>
        <p className="total"><span>Discounts</span><b>−{money(order.discount)}</b></p>
        <p className="total"><span>Total</span><b>{money(order.total)}</b></p>
        <label>Fulfillment status
          <select aria-label="Update order status" value={order.status} onChange={e => updateStatus(e.target.value)}>
            {orderStatuses.map(value => <option key={value} value={value}>{title(value)}</option>)}
          </select>
        </label>
      </section>
      <section className="ops-panel">
        <h2>Discretionary discount</h2>
        <form className="checkout-form" onSubmit={applyDiscount}>
          <label>Amount ($)
            <input aria-label="Discount amount" type="number" min="1" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} required />
          </label>
          <label>Reason<textarea aria-label="Discount reason" rows={3} value={reason} onChange={e => setReason(e.target.value)} required placeholder="Why is this courtesy being issued?" /></label>
          <button className="primary">Apply courtesy credit</button>
        </form>
        {(order.discounts || []).map(item => <p key={item.id} className="ops-note"><b>{money(item.amount)}</b> {item.discountName} — {item.reason}</p>)}
      </section>
    </div>
  </>;
}

function Returns() {
  const [rows, setRows] = useState<OpsReturn[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const load = () => api<OpsReturn[]>(`/api/admin/returns${status ? `?status=${status}` : ""}`).then(setRows).catch(err => setError(err.message));
  useEffect(() => { load(); }, [status]);
  const update = async (id: string, next: string) => {
    try {
      await api(`/api/admin/returns/${id}`, { method: "PATCH", body: JSON.stringify({ status: next, note: `Moved to ${title(next)}` }) });
      load();
    } catch (err) { setError(err instanceof ApiError ? err.message : "Could not update return"); }
  };
  return <>
    <div className="ops-head"><h1>Returns</h1><p>Approve, receive, complete, or reject member returns. Completing a refund restocks the warehouse.</p></div>
    {error && <div className="alert" role="alert">{error}</div>}
    <div className="ops-toolbar">
      <label>Status
        <select aria-label="Filter return status" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">All returns</option>
          {returnStatuses.map(value => <option key={value} value={value}>{title(value)}</option>)}
        </select>
      </label>
    </div>
    <div className="ops-table-wrap">
      <table className="ops-table">
        <thead><tr><th>Return</th><th>Order</th><th>Member</th><th>Reason</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id}>
          <td><b>{row.returnNumber}</b><small>{row.type} · {title(row.method)}</small></td>
          <td>{row.orderNumber}</td><td>{row.memberEmail}</td><td>{row.reason}</td>
          <td><span className={statusClass(row.status)}>{title(row.status)}</span></td>
          <td>
            <select aria-label={`Update ${row.returnNumber}`} value={row.status} onChange={e => update(row.id, e.target.value)}>
              {returnStatuses.map(value => <option key={value} value={value}>{title(value)}</option>)}
            </select>
          </td>
        </tr>)}</tbody>
      </table>
    </div>
  </>;
}

function Discounts() {
  const [rows, setRows] = useState<OpsDiscount[]>([]);
  const [error, setError] = useState("");
  const load = () => api<OpsDiscount[]>("/api/admin/discounts").then(setRows).catch(err => setError(err.message));
  useEffect(() => { load(); }, []);
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/admin/discounts", {
        method: "POST",
        body: JSON.stringify({
          name: String(form.get("name")),
          code: String(form.get("code") || "") || undefined,
          type: String(form.get("type")),
          value: Number(form.get("value")),
          reason: String(form.get("reason")),
          notes: String(form.get("notes") || ""),
        }),
      });
      event.currentTarget.reset();
      load();
    } catch (err) { setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Could not create discount"); }
  };
  const revoke = async (id: string) => {
    await api(`/api/admin/discounts/${id}`, { method: "PATCH", body: JSON.stringify({ status: "revoked" }) });
    load();
  };
  return <>
    <div className="ops-head"><h1>Discretionary discounts</h1><p>Create courtesy codes or one-off adjustments. Applying them happens on the order.</p></div>
    {error && <div className="alert" role="alert">{error}</div>}
    <div className="ops-split">
      <form className="ops-panel checkout-form" onSubmit={create}>
        <h2>New discount</h2>
        <label>Name<input name="name" required placeholder="Warehouse goodwill" /></label>
        <label>Code <span>(optional)</span><input name="code" placeholder="COURTESY10" /></label>
        <div className="form-row">
          <label>Type<select name="type"><option value="amount">Dollar amount</option><option value="percent">Percent</option></select></label>
          <label>Value<input name="value" type="number" min="1" step="0.01" required defaultValue="15" /></label>
        </div>
        <label>Reason<textarea name="reason" rows={3} required /></label>
        <label>Notes<textarea name="notes" rows={2} /></label>
        <button className="primary">Save discount</button>
      </form>
      <div className="ops-table-wrap">
        <table className="ops-table">
          <thead><tr><th>Discount</th><th>Value</th><th>Uses</th><th>Status</th><th /></tr></thead>
          <tbody>{rows.map(row => <tr key={row.id}>
            <td><b>{row.name}</b><small>{row.code || "No code"} · {row.reason}</small></td>
            <td>{row.type === "percent" ? `${row.value}%` : money(row.value)}</td>
            <td>{row.usedCount}{row.maxUses ? ` / ${row.maxUses}` : ""}</td>
            <td><span className={statusClass(row.status)}>{row.status}</span></td>
            <td>{row.status === "active" && <button type="button" className="text-btn" onClick={() => revoke(row.id)}>Revoke</button>}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </div>
  </>;
}
