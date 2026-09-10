import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { getKirkHome, placeKirkPreorder } from "./api";
import { categories, warehouses } from "./data";
import { Empty, ProductCard, Quantity } from "./components";
import { useAssistant } from "./assistant";
import { useProductImages } from "./product-images";
import { fallbackKirkHome } from "./kirk-home";
import { useStore } from "./store";
import type { KirkHome, Product, Shipping } from "./types";

export function Home() {
  const { products, user } = useStore();
  const { openAssistant } = useAssistant();
  const [kirk, setKirk] = useState<KirkHome>(() => fallbackKirkHome(user?.email ?? "demo"));
  const [preorderNote, setPreorderNote] = useState("");
  useEffect(() => {
    getKirkHome(user?.email ?? "demo").then(setKirk).catch(() => setKirk(fallbackKirkHome(user?.email ?? "demo")));
  }, [user?.email]);
  return <><section className="hero"><div><span>MEMBER-ONLY SAVINGS</span><h1>More value in every cart.</h1><p>Fresh finds, Kirkland Signature, and warehouse prices — shop with Kirk, your Costco assistant.</p><div className="hero-ctas"><Link className="hero-btn" to="/search">Shop savings</Link><button type="button" className="secondary" onClick={() => openAssistant()}>Talk to Kirk</button></div></div><div className="hero-visual" aria-hidden="true"><span /><span /><span /></div></section>
    <section className="kirk-row" aria-label="Kirk assistant">
      <div className="kirk-row-open">
        <p>Hi, {kirk.member.displayName}</p>
        <h2>Ask Kirk</h2>
        <span>Chat, live voice, a pantry photo, or Imagine your cart.</span>
        <button type="button" className="primary" onClick={() => openAssistant()}>Open Kirk</button>
      </div>
      <div className="kirk-suggestions">
        {kirk.suggestions.map((tile) => (
          <button type="button" className="kirk-tile" key={tile.id} aria-label={tile.label} onClick={() => openAssistant(tile.prompt)}>
            <img src={tile.heroUrl} alt="" />
            <b>{tile.label}</b>
            <small>{tile.reason}</small>
          </button>
        ))}
      </div>
    </section>
    {kirk.preorderItems.length > 0 && <section className="page-section kirk-preorder-strip">
      <div className="section-head"><h2>Available to preorder</h2></div>
      {preorderNote && <p className="notice" role="status">{preorderNote}</p>}
      <div className="product-row">{kirk.preorderItems.map((item) => (
        <article className="product-card" key={item.id}>
          <b>{item.name}</b>
          <p>{item.description || "Merch approved this buy. Preorder is open now."}</p>
          <button className="primary" type="button" onClick={async () => {
            try {
              await placeKirkPreorder(item.id, user?.email ?? "demo");
              setPreorderNote(`Preorder placed for ${item.name}.`);
            } catch {
              setPreorderNote("Could not place that preorder.");
            }
          }}>Preorder</button>
        </article>
      ))}</div>
    </section>}
    <section className="service-row"><div><b>Same-Day Delivery</b><span>Fresh groceries to your door</span></div><div><b>2-Day Delivery</b><span>Pantry and household essentials</span></div><div><b>Executive Rewards</b><span>Earn 2% back on purchases</span></div><div><b>Risk-Free Shopping</b><span>Return to any warehouse</span></div></section>
    <section className="page-section"><div className="section-head"><h2>Shop popular categories</h2><Link to="/search">View all</Link></div><div className="category-grid">{categories.map(([slug, name], i) => <Link to={`/category/${slug}`} key={slug} className={`cat-tile cat-${i}`}><span /><b>{name}</b></Link>)}</div></section>
    <ProductCarousel title="Member favorites" items={products.filter(p => p.featured || p.badge).slice(0, 8)} />
    <section className="promo-grid"><Link to="/category/electronics"><b>Tech upgrades</b><span>Premium electronics at member value. Ask the assistant to compare TVs by size and stock.</span></Link><Link to="/category/household"><b>Household staples</b><span>Kirkland Signature paper, laundry, and cleaning — warehouse pack sizes.</span></Link></section>
    <ProductCarousel title="Electronics" items={products.filter(p => p.category === "electronics").slice(0, 8)} />
    <ProductCarousel title="Furniture" items={products.filter(p => p.category === "furniture").slice(0, 8)} />
    <ProductCarousel title="Household" items={products.filter(p => p.category === "household").slice(0, 8)} /></>;
}
function ProductCarousel({ title, items }: { title: string; items: Product[] }) { return <section className="page-section"><div className="section-head"><h2>{title}</h2><Link to="/search">View all</Link></div><div className="product-row">{items.map(p => <ProductCard key={p.id} product={p} />)}</div></section>; }

export function Listing() {
  const { slug } = useParams(); const [search] = useSearchParams(); const q = search.get("q") || ""; const { products } = useStore();
  const [sort, setSort] = useState("featured"); const [grid, setGrid] = useState(true); const [compare, setCompare] = useState<Product[]>([]);
  let items = products.filter(p => (!slug || p.category === slug) && (!q || p.name.toLowerCase().includes(q.toLowerCase())));
  if (sort === "low") items = [...items].sort((a,b) => a.price-b.price); if (sort === "high") items = [...items].sort((a,b) => b.price-a.price); if (sort === "rating") items = [...items].sort((a,b) => b.rating-a.rating);
  const title = slug ? categories.find(c => c[0] === slug)?.[1] || "Products" : q ? `Search results for “${q}”` : "All products";
  const toggle = (p: Product) => setCompare(c => c.some(x => x.id === p.id) ? c.filter(x => x.id !== p.id) : c.length < 3 ? [...c,p] : c);
  return <div className="listing"><div className="breadcrumbs"><Link to="/">Home</Link> / {title}</div><h1>{title}</h1><div className="catalog-layout"><aside className="filters"><h2>Filter by</h2>{["Category", "Brand", "Price", "Product Rating", "Availability"].map((name,i) => <details key={name} open={i < 2}><summary>{name}</summary>{(i ? ["Under $50", "$50–$200", "$200 & up"] : categories.slice(0,4).map(c => c[1])).map(x => <label key={x}><input type="checkbox" /> {x}</label>)}</details>)}</aside>
    <section className="results"><div className="results-bar"><b>{items.length} results</b><label>Sort by <select aria-label="Sort products" value={sort} onChange={e => setSort(e.target.value)}><option value="featured">Featured</option><option value="low">Price: Low to High</option><option value="high">Price: High to Low</option><option value="rating">Top Rated</option></select></label><div><button aria-label="Grid view" className={grid ? "active" : ""} onClick={() => setGrid(true)}>▦</button><button aria-label="List view" className={!grid ? "active" : ""} onClick={() => setGrid(false)}>☷</button></div></div>
    {items.length ? <div className={grid ? "product-grid" : "product-grid list"}>{items.map(p => <ProductCard key={p.id} product={p} compare={compare.some(c => c.id === p.id)} onCompare={toggle} />)}</div> : <Empty title="No products found" text="Try a broader search or browse our popular categories." action={<Link className="primary link-btn" to="/">Browse categories</Link>} />}</section></div>
    {compare.length > 0 && <div className="compare-tray"><b>Compare products ({compare.length}/3)</b>{compare.map(p => <span key={p.id}>{p.name}<button onClick={() => toggle(p)}>×</button></span>)}<button className="primary" onClick={() => alert("Comparison preview is ready for this demo.")}>Compare now</button></div>}</div>;
}

export function ProductDetail() {
  const { id } = useParams();
  const { products, warehouse, add } = useStore();
  const { openAssistant } = useAssistant();
  const { urlFor } = useProductImages();
  const product = products.find(p => p.id === id);
  if (!product) return <Empty title="Product not found" text="This item may no longer be available." action={<Link to="/">Go home</Link>} />;
  const stock = product.stockByWarehouse[warehouse.id] || 0;
  const categoryName = categories.find(c => c[0] === product.category)?.[1] || product.category;
  const itemNumber = product.sku || product.id.padStart(8, "0");
  const related = products.filter(p => p.id !== id && p.category === product.category).slice(0, 5);
  return (
    <div className="product-detail">
      <div className="breadcrumbs"><Link to="/">Home</Link> / <Link to={`/category/${product.category}`}>{categoryName}</Link> / {product.name}</div>
      <div className="detail-grid">
        <div className="detail-image"><img src={urlFor(product.id, product.image)} alt={product.name} /></div>
        <div>
          {product.badge && <span className="badge">{product.badge}</span>}
          {product.brand && <p className="product-brand">{product.brand}</p>}
          <h1>{product.name}</h1>
          <div className="rating">★★★★★ <span>{product.rating} ({product.reviews} reviews)</span></div>
          <p className="sku">Item #{itemNumber}</p>
          <hr />
          <span className="member-label">MEMBER PRICE</span>
          <div className="detail-price">${product.memberPrice?.toFixed(2)}</div>
          {product.compareAtPrice != null && <p className="compare-price">${product.compareAtPrice.toFixed(2)}</p>}
          <p>Shipping & handling included</p>
          <div className="fulfillment">
            <b>Warehouse availability</b>
            <span className={stock ? "in-stock" : "out-stock"}>{stock ? `${stock} available at ${warehouse.name}` : `Out of stock at ${warehouse.name}`}</span>
            <div className="warehouse-stock">
              {Object.entries(product.stockByWarehouse).map(([warehouseId, quantity]) => {
                const location = warehouses.find(item => item.id === warehouseId);
                if (!location) return null;
                return <p key={warehouseId}><span>{location.name}</span><b className={quantity ? "in-stock" : "out-stock"}>{quantity ? `${quantity} on hand` : "Out of stock"}</b></p>;
              })}
            </div>
          </div>
          <button className="primary big" disabled={!stock} onClick={() => add(product.id)}>Add to Cart</button>
          <button type="button" className="secondary big" onClick={() => openAssistant(`Tell me about ${product.name}`)}>Ask Costco about this item</button>
          <details open>
            <summary>Product details</summary>
            <p>{product.description}</p>
            <ul>
              <li>Costco member satisfaction guarantee</li>
              <li>Quality inspected and ready to ship</li>
              <li>Returns accepted at any warehouse</li>
            </ul>
          </details>
          {product.specs && product.specs.length > 0 && (
            <details open>
              <summary>Specifications</summary>
              <table className="spec-table">
                <tbody>
                  {product.specs.map(spec => (
                    <tr key={`${spec.name}-${spec.value}`}>
                      <th>{spec.name}</th>
                      <td>{spec.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </div>
      </div>
      <ProductCarousel title="You may also like" items={related.length ? related : products.filter(p => p.id !== id).slice(0, 5)} />
    </div>
  );
}

export function Cart() {
  const { cart, products, cartTotal, warehouse } = useStore(); const { openAssistant } = useAssistant();
  const lines = cart.map(i => ({...i, product: products.find(p => p.id === i.productId)!}));
  if (!lines.length) return <Empty title="Your cart is empty" text="Members find more value every day." action={<Link className="primary link-btn" to="/search">Start shopping</Link>} />;
  return <div className="cart-page"><h1>Shopping Cart</h1><div className="cart-layout"><section>{lines.map(({product,quantity}) => <article className="cart-line" key={product.id}><img src={product.image} alt="" /><div><Link to={`/product/${product.id}`}><b>{product.name}</b></Link><p className={(product.stockByWarehouse[warehouse.id]||0) ? "in-stock":"out-stock"}>{(product.stockByWarehouse[warehouse.id]||0) ? `In stock at ${warehouse.name}` : `Unavailable at ${warehouse.name} — stays in cart`}</p><Quantity id={product.id} quantity={quantity} /></div><strong>${((product.memberPrice||0)*quantity).toFixed(2)}</strong></article>)}</section><aside className="summary"><h2>Order Summary</h2><p><span>Subtotal</span><b>${cartTotal.toFixed(2)}</b></p><p><span>Shipping</span><b>Included</b></p><hr/><p className="total"><span>Estimated Total</span><b>${cartTotal.toFixed(2)}</b></p><Link className="primary link-btn" to="/checkout">Checkout</Link><button type="button" className="secondary big" onClick={() => openAssistant("Help me check out")}>Checkout with voice</button><small>Secure checkout · Ask Costco to place this order</small></aside></div></div>;
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user } = useStore(); const location = useLocation();
  return user ? children : <Navigate to="/signin" replace state={{ from: location.pathname }} />;
}

export function Auth({ register = false }: { register?: boolean }) {
  const store = useStore(); const navigate = useNavigate(); const location = useLocation(); const [error,setError]=useState("");
  const submit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget); const email=String(f.get("email")); const name=String(f.get("name")||"");
    if (!email.includes("@") || String(f.get("password")).length < 6) return setError("Enter a valid email and password of at least 6 characters.");
    register ? store.register(email,name) : store.login(email); navigate((location.state as {from?:string})?.from || "/account"); };
  return <div className="auth-card"><h1>{register ? "Create your account" : "Sign in"}</h1><p>{register ? "Start enjoying member-only value." : "Welcome back. Access your account and orders."}</p>{error && <div className="alert" role="alert">{error}</div>}<form onSubmit={submit}>{register && <label>Full name<input name="name" required /></label>}<label>Email address<input name="email" type="email" required /></label><label>Password<input name="password" type="password" minLength={6} required /></label>{register && <label>Membership number <span>(optional)</span><input name="membership" /></label>}<button className="primary big">{register ? "Create Account" : "Sign In"}</button></form><p>{register ? <>Already have an account? <Link to="/signin">Sign in</Link></> : <>New to Costco? <Link to="/register">Create an account</Link></>}</p><small>Demo tip: any valid email and 6+ character password works.</small></div>;
}

export function Checkout() {
  const { cart, cartTotal, placeOrder } = useStore(); const navigate=useNavigate(); const [step,setStep]=useState(1); const [placing,setPlacing]=useState(false); const [shipping,setShipping]=useState<Shipping>({name:"",address:"",city:"",state:"",zip:""});
  if (!cart.length && !placing) return <Navigate to="/cart" />;
  const submitShipping=(e:FormEvent<HTMLFormElement>)=>{e.preventDefault(); setStep(2)}; const place=(e:FormEvent<HTMLFormElement>)=>{e.preventDefault(); setPlacing(true); const order=placeOrder(shipping); navigate(`/order/${order.id}`)};
  return <div className="checkout"><h1>Secure Checkout</h1><div className="steps"><b className={step===1?"active":""}>1 Shipping</b><b className={step===2?"active":""}>2 Payment</b><b>3 Confirmation</b></div>{step===1?<form className="checkout-form" onSubmit={submitShipping}><h2>Shipping information</h2>{Object.keys(shipping).map(key=><label key={key}>{key[0].toUpperCase()+key.slice(1)}<input required value={shipping[key as keyof Shipping]} onChange={e=>setShipping({...shipping,[key]:e.target.value})}/></label>)}<button className="primary">Continue to payment</button></form>:<form className="checkout-form" onSubmit={place}><h2>Payment</h2><div className="notice">🔒 Payment details are simulated and never stored.</div><label>Card number<input required inputMode="numeric" pattern="[0-9 ]{15,19}" placeholder="4242 4242 4242 4242"/></label><div className="form-row"><label>Expiration<input required placeholder="MM/YY"/></label><label>Security code<input required pattern="[0-9]{3,4}" placeholder="CVV"/></label></div><p className="total"><span>Order total</span><b>${cartTotal.toFixed(2)}</b></p><button className="primary">Place order</button><button type="button" className="secondary" onClick={()=>setStep(1)}>Back</button></form>}</div>;
}

export function Account() {
  const { user, logout } = useStore();
  const [kirk, setKirk] = useState<KirkHome>(() => fallbackKirkHome(user?.email ?? "demo"));
  useEffect(() => {
    getKirkHome(user?.email ?? "demo").then(setKirk).catch(() => undefined);
  }, [user?.email]);
  return <div className="account"><h1>Welcome, {user?.name}</h1><div className="account-grid"><Link to="/account/orders"><span>📦</span><b>Your Orders</b><small>Track, return, or buy things again</small></Link><div><span>♙</span><b>Account Details</b><small>{user?.email}</small></div><div><span>★</span><b>Membership</b><small>Gold Star Member</small></div><div><span>⌖</span><b>Kirk history</b><small>{kirk.member.unmetInterests.map((item) => item.text).join(" · ") || "No unmet interests yet"}</small></div></div><button className="secondary" onClick={logout}>Sign out</button></div>;
}
export function Orders() { const {orders}=useStore(); return <div className="orders"><h1>Your Orders</h1>{orders.length?orders.map(o=><Link className="order-card" key={o.id} to={`/account/orders/${o.id}`}><div><b>{o.id}</b><span>{new Date(o.createdAt).toLocaleDateString()}</span></div><div><span>{o.status}</span><b>${o.total.toFixed(2)}</b></div></Link>):<Empty title="No orders yet" text="Once you place an order, it will appear here." action={<Link to="/search">Shop products</Link>}/>}</div>; }
export function OrderDetail({confirmation=false}:{confirmation?:boolean}) { const {id}=useParams(); const {orders,products}=useStore(); const o=orders.find(x=>x.id===id); if(!o)return <Empty title="Order not found" text="We couldn't locate this order."/>; return <div className="order-detail">{confirmation&&<div className="success">✓<h1>Thanks for your order!</h1><p>A confirmation has been saved to your account.</p></div>}<h2>Order {o.id}</h2><div className="notice"><b>{o.returnStatus||o.status}</b><span>Estimated delivery in 3–5 business days</span></div>{o.items.map(i=>{const p=products.find(x=>x.id===i.productId)!;return <div className="mini-line" key={i.productId}><img src={p.image} alt=""/><span>{p.name}<small>Qty {i.quantity}</small></span><b>${((p.memberPrice||0)*i.quantity).toFixed(2)}</b></div>})}<p className="total"><span>Total</span><b>${o.total.toFixed(2)}</b></p><h3>Shipping to</h3><p>{o.shipping.name}<br/>{o.shipping.address}<br/>{o.shipping.city}, {o.shipping.state} {o.shipping.zip}</p>{!o.returnStatus&&<Link className="secondary link-btn" to={`/account/orders/${o.id}/return`}>Return items</Link>}</div>; }
export function ReturnOrder() { const {id}=useParams(); const {orders,returnOrder}=useStore(); const nav=useNavigate(); const o=orders.find(x=>x.id===id); if(!o)return <Empty title="Order not found" text="We couldn't locate this order."/>; const submit=(e:FormEvent)=>{e.preventDefault();returnOrder(o.id);nav(`/account/orders/${o.id}`)};return <div className="checkout"><h1>Start a return</h1><form className="checkout-form" onSubmit={submit}><h2>Why are you returning these items?</h2><label>Reason<select required defaultValue=""><option value="" disabled>Select a reason</option><option>Changed my mind</option><option>Damaged or defective</option><option>Wrong item received</option></select></label><label>Additional details<textarea rows={4}/></label><div className="notice">Items can also be returned at any Costco warehouse.</div><button className="primary">Submit return request</button></form></div>; }
