import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { getKirkHome, markKirkNotificationRead, placeKirkPreorder } from "./api";
import { AssistantProvider, HeadsetIcon, useAssistant } from "./assistant";
import { warehouses } from "./data";
import { useStore } from "./store";
import type { KirkNotification, Product } from "./types";

const navLinks = [
  ["/category/grocery", "Grocery"],
  ["/category/electronics", "Electronics"],
  ["/category/furniture", "Furniture"],
  ["/category/household", "Household"],
  ["/search", "Same-Day"],
  ["/search", "Savings"],
  ["/search", "Business Delivery"],
  ["/search", "Optical"],
  ["/search", "Pharmacy"],
  ["/search", "Services"],
  ["/search", "Travel"],
  ["/search", "Membership"],
  ["/search", "Locations"]
] as const;

function IconUser() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.8" /><path d="M5 19c1.4-3.2 4-5 7-5s5.6 1.8 7 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
}
function IconCart() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5h2l1.2 8.4A2 2 0 0 0 9.18 15h8.2a2 2 0 0 0 1.96-1.6L21 8H7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><circle cx="10" cy="19" r="1.4" fill="currentColor" /><circle cx="18" cy="19" r="1.4" fill="currentColor" /></svg>;
}
function IconPin() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z" stroke="currentColor" strokeWidth="1.8" /><circle cx="12" cy="10" r="2.2" fill="currentColor" /></svg>;
}
function IconSearch({ light = false }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="6.5" stroke={light ? "#fff" : "#8B919A"} strokeWidth="2" /><path d="M16.5 16.5L21 21" stroke={light ? "#fff" : "#8B919A"} strokeWidth="2" strokeLinecap="round" /></svg>;
}

export function Logo() {
  return <Link className="logo" to="/" aria-label="Costco demo home">
    <strong>COSTCO</strong>
    <span className="logo-sub"><span className="logo-bars" aria-hidden="true"><i /><i /><i /></span><em>WHOLESALE</em></span>
  </Link>;
}

export function Header() {
  const { user, cartCount, warehouse, deliveryZip, setDeliveryZip } = useStore();
  const { openAssistant } = useAssistant();
  const [warehouseOpen, setWarehouseOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const search = (e: React.FormEvent) => { e.preventDefault(); navigate(`/search?q=${encodeURIComponent(query)}`); };
  return <header>
    <div className="utility"><span>While Supplies Last</span><span>Online-Only</span><span>Treasure Hunt</span><span>What's New</span><span>Member Favorites</span><Link to="/service">Customer Service</Link></div>
    <div className="header-main">
      <button className="menu-btn" aria-label="Toggle menu" onClick={() => setMobile(!mobile)}>☰</button>
      <Logo />
      <form className="search" onSubmit={search}>
        <IconSearch />
        <input aria-label="Search products" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search Costco or ask with voice" />
        <button type="button" className="search-voice" aria-label="Ask Kirk" onClick={() => openAssistant(query || undefined)}><HeadsetIcon size={18} /></button>
        <button type="submit" className="search-go" aria-label="Submit search"><IconSearch light /></button>
      </form>
      <div className="head-links">
        <Link to={user ? "/account" : "/signin"}><IconUser /><span>{user ? `Hi, ${user.name}` : "Sign In"}<small>Account & Orders</small></span></Link>
        <KirkBell />
        <Link to="/cart"><IconCart /><span>Cart<small>{cartCount} item{cartCount === 1 ? "" : "s"}</small></span></Link>
      </div>
    </div>
    <nav className={mobile ? "nav open" : "nav"}>
      <button type="button" onClick={() => setMobile(!mobile)}><b>Shop</b></button>
      {navLinks.map(([href, name]) => href.startsWith("/category")
        ? <NavLink key={name} to={href}>{name}</NavLink>
        : <Link key={name} to={href}>{name}</Link>)}
    </nav>
    <div className="location-bar">
      <button onClick={() => setWarehouseOpen(true)}><IconPin /> My Warehouse: <b>{warehouse.name}</b> · Open until 8:30 PM</button>
      <label>Delivery ZIP <input aria-label="Delivery ZIP" value={deliveryZip} onChange={e => setDeliveryZip(e.target.value.replace(/\D/g, "").slice(0, 5))} placeholder="11232" /></label>
      <span className="location-spacer" />
      <Link to="/search">Lists</Link>
      <Link to="/account/orders">Buy Again</Link>
    </div>
    {warehouseOpen && <WarehouseModal close={() => setWarehouseOpen(false)} />}
  </header>;
}

function WarehouseModal({ close }: { close: () => void }) {
  const { setWarehouse } = useStore(); const [q, setQ] = useState("");
  const options = warehouses.filter(w => `${w.name} ${w.city} ${w.state} ${w.zip}`.toLowerCase().includes(q.toLowerCase()));
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && close()}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="warehouse-title">
    <button className="close" aria-label="Close" onClick={close}>×</button><h2 id="warehouse-title">Find a Costco warehouse</h2>
    <input autoFocus aria-label="Search by city, state, or ZIP" placeholder="City, state, or ZIP" value={q} onChange={e => setQ(e.target.value)} />
    <div className="warehouse-list">{options.length ? options.map(w => <button key={w.id} onClick={() => { setWarehouse(w); close(); }}><b>{w.name}, {w.state}</b><span>{w.address}, {w.zip}</span><small>Open until 8:30 PM</small></button>) : <Empty title="No warehouses found" text="Try another city, state, or ZIP." />}</div>
  </section></div>;
}

function KirkBell() {
  const { user } = useStore();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<KirkNotification[]>([]);
  const [note, setNote] = useState("");
  const load = () => getKirkHome(user?.email ?? "demo").then((home) => setItems(home.notifications)).catch(() => undefined);
  useEffect(() => { load(); }, [user?.email]);
  const unread = items.filter((item) => !item.read).length;
  return <div className="kirk-bell">
    <button type="button" className="kirk-bell-btn" aria-label="Notifications" aria-expanded={open} onClick={() => {
      setOpen((value) => {
        const next = !value;
        if (next) load();
        return next;
      });
    }}>
      <span aria-hidden="true">🔔</span>
      {unread > 0 && <b>{unread}</b>}
    </button>
    {open && <div className="kirk-bell-panel" role="dialog" aria-label="In-app notifications">
      {note && <p role="status">{note}</p>}
      {items.length === 0 ? <p>No preorder notices yet.</p> : items.map((item) => (
        <article key={item.id}>
          <b>{item.title}</b>
          <span>{item.body}</span>
          <div>
            {item.itemId && <button type="button" className="text-btn" onClick={async () => {
              try {
                await placeKirkPreorder(item.itemId!, user?.email ?? "demo");
                setNote(`Preorder placed.`);
              } catch { setNote("Preorder is not open yet."); }
            }}>Preorder</button>}
            {!item.read && <button type="button" className="text-btn" onClick={async () => {
              await markKirkNotificationRead(item.id).catch(() => undefined);
              load();
            }}>Mark read</button>}
          </div>
        </article>
      ))}
    </div>}
  </div>;
}

export function ProductCard({ product, compare, onCompare }: { product: Product; compare?: boolean; onCompare?: (p: Product) => void }) {
  const { add, warehouse } = useStore(); const stock = product.stockByWarehouse[warehouse.id] || 0;
  return <article className="product-card">
    <Link to={`/product/${product.id}`} className="product-image"><img src={product.image} alt="" /></Link>
    {product.badge && <span className="badge">{product.badge}</span>}
    <div className="rating" aria-label={`${product.rating} out of 5 stars`}>★★★★★ <span>{product.rating} ({product.reviews})</span></div>
    <Link className="product-name" to={`/product/${product.id}`}>{product.name}</Link>
    <span className="member-label">MEMBER PRICE</span><strong className="price">${product.memberPrice?.toFixed(2)}</strong>
    <p className={stock ? "in-stock" : "out-stock"}>{stock ? `In stock at ${warehouse.name}` : `Out of stock at ${warehouse.name}`}</p>
    <button className="primary" disabled={!stock} onClick={() => add(product.id)}>Add to Cart</button>
    {onCompare && <label className="compare"><input type="checkbox" checked={compare} onChange={() => onCompare(product)} /> Compare</label>}
  </article>;
}

export function Quantity({ id, quantity }: { id: string; quantity: number }) {
  const { setQuantity } = useStore();
  return <div className="quantity" aria-label="Quantity controls"><button aria-label="Decrease quantity" onClick={() => setQuantity(id, quantity - 1)}>−</button><span>{quantity}</span><button aria-label="Increase quantity" onClick={() => setQuantity(id, quantity + 1)}>+</button></div>;
}

export function Shell({ children }: { children: ReactNode }) {
  return <AssistantProvider><Header /><main>{children}</main><Footer /></AssistantProvider>;
}
export function Empty({ title, text, action }: { title: string; text: string; action?: ReactNode }) { return <div className="empty"><div>▢</div><h2>{title}</h2><p>{text}</p>{action}</div>; }
export function Footer() {
  return <footer>
    <div className="footer-cols">
      <div><h3>Customer Service</h3><a href="#">Contact Us</a><a href="#">Returns & Exchanges</a><a href="#">Shipping</a><a href="#">Order Status</a></div>
      <div><h3>About Us</h3><a href="#">Our Values</a><a href="#">Kirkland Signature</a><a href="#">Careers</a><a href="#">Sustainability</a></div>
      <div><h3>Membership</h3><a href="#">Join Costco</a><a href="#">Executive Rewards</a><a href="#">Member Privileges</a><a href="#">Credit Card</a></div>
      <div><h3>Get Email Offers</h3><div className="email-offer"><input aria-label="Email offers" placeholder="Enter your email" /><button>Sign Up</button></div></div>
    </div>
    <p className="disclaimer"><b>Internal demonstration only.</b> This project is not affiliated with, endorsed by, or operated by Costco Wholesale Corporation. Product names, prices, and availability are fictional.</p>
    <p>© 2026 Commerce Demo · Privacy · Terms · Accessibility</p>
  </footer>;
}
