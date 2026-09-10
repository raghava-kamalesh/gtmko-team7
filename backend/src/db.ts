import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { count, eq } from "drizzle-orm";
import { seedCostcoCatalog } from "./catalog-seed.js";
import kirkMembers from "../../shared/kirk-members.json" with { type: "json" };
import * as schema from "./schema.js";
import { hashPassword } from "./security.js";

export type Database = PgliteDatabase<typeof schema>;
export interface DatabaseContext {
  client: PGlite;
  db: Database;
  close: () => Promise<void>;
}

const schemaSql = `
CREATE TABLE IF NOT EXISTS categories (
  id text PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL, description text NOT NULL,
  image_url text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS products (
  id text PRIMARY KEY, sku text NOT NULL UNIQUE, category_id text NOT NULL REFERENCES categories(id),
  slug text NOT NULL UNIQUE, name text NOT NULL, brand text NOT NULL, description text NOT NULL,
  price numeric(12,2) NOT NULL, compare_at_price numeric(12,2), rating numeric(2,1) NOT NULL,
  review_count integer NOT NULL DEFAULT 0, featured boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS product_media (
  id text PRIMARY KEY, product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url text NOT NULL, alt text NOT NULL, position integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS product_specs (
  id text PRIMARY KEY, product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name text NOT NULL, value text NOT NULL, position integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS warehouses (
  id text PRIMARY KEY, number text NOT NULL UNIQUE, name text NOT NULL, address1 text NOT NULL,
  city text NOT NULL, state text NOT NULL, zip text NOT NULL, phone text NOT NULL,
  latitude numeric(9,6) NOT NULL, longitude numeric(9,6) NOT NULL, hours jsonb NOT NULL,
  services jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS inventory (
  id text PRIMARY KEY, warehouse_id text NOT NULL REFERENCES warehouses(id),
  product_id text NOT NULL REFERENCES products(id), quantity integer NOT NULL DEFAULT 0,
  aisle text, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(warehouse_id, product_id)
);
CREATE TABLE IF NOT EXISTS members (
  id text PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'member', membership_number text UNIQUE,
  membership_tier text NOT NULL DEFAULT 'gold_star', membership_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS profiles (
  member_id text PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE, first_name text NOT NULL,
  last_name text NOT NULL, phone text, marketing_opt_in boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY, member_id text NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS addresses (
  id text PRIMARY KEY, member_id text NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  label text NOT NULL, first_name text NOT NULL, last_name text NOT NULL, address1 text NOT NULL,
  address2 text, city text NOT NULL, state text NOT NULL, zip text NOT NULL, phone text,
  is_default boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS carts (
  id text PRIMARY KEY, member_id text REFERENCES members(id) ON DELETE CASCADE, guest_token text UNIQUE,
  warehouse_id text REFERENCES warehouses(id), status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cart_items (
  id text PRIMARY KEY, cart_id text NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id text NOT NULL REFERENCES products(id), quantity integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(cart_id, product_id)
);
CREATE TABLE IF NOT EXISTS orders (
  id text PRIMARY KEY, order_number text NOT NULL UNIQUE, member_id text NOT NULL REFERENCES members(id),
  warehouse_id text NOT NULL REFERENCES warehouses(id), status text NOT NULL, fulfillment_type text NOT NULL,
  subtotal numeric(12,2) NOT NULL, tax numeric(12,2) NOT NULL,
  discount numeric(12,2) NOT NULL DEFAULT 0, total numeric(12,2) NOT NULL,
  shipping_address jsonb, payment jsonb NOT NULL, placed_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS order_items (
  id text PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id text NOT NULL REFERENCES products(id), sku text NOT NULL, name text NOT NULL,
  unit_price numeric(12,2) NOT NULL, quantity integer NOT NULL, image_url text
);
CREATE TABLE IF NOT EXISTS shipments (
  id text PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  carrier text, tracking_number text, status text NOT NULL, shipped_at timestamptz, delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS returns (
  id text PRIMARY KEY, return_number text NOT NULL UNIQUE, order_id text NOT NULL REFERENCES orders(id),
  member_id text NOT NULL REFERENCES members(id), type text NOT NULL, method text NOT NULL,
  warehouse_id text REFERENCES warehouses(id), reason text NOT NULL, status text NOT NULL,
  label_url text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS return_items (
  id text PRIMARY KEY, return_id text NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  order_item_id text NOT NULL REFERENCES order_items(id), quantity integer NOT NULL, resolution text NOT NULL
);
CREATE TABLE IF NOT EXISTS return_history (
  id text PRIMARY KEY, return_id text NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  status text NOT NULL, note text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS discounts (
  id text PRIMARY KEY, code text UNIQUE, name text NOT NULL, type text NOT NULL,
  value numeric(12,2) NOT NULL, reason text NOT NULL, status text NOT NULL DEFAULT 'active',
  created_by text REFERENCES members(id), max_uses integer, used_count integer NOT NULL DEFAULT 0,
  expires_at timestamptz, notes text, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS discount_applications (
  id text PRIMARY KEY, discount_id text NOT NULL REFERENCES discounts(id),
  order_id text NOT NULL REFERENCES orders(id), amount numeric(12,2) NOT NULL,
  applied_by text NOT NULL REFERENCES members(id), reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kirk_category_heroes (
  id text PRIMARY KEY, category text NOT NULL UNIQUE, label text NOT NULL, prompt text NOT NULL,
  image_url text, source text NOT NULL DEFAULT 'placeholder',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kirk_product_images (
  id text PRIMARY KEY, product_id text NOT NULL UNIQUE, image_url text,
  source text NOT NULL DEFAULT 'placeholder', prompt text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kirk_feedback (
  id text PRIMARY KEY, member_key text NOT NULL, type text NOT NULL, details text NOT NULL,
  transcript jsonb NOT NULL, linear_issue_id text, linear_identifier text, linear_url text,
  agent_job_id text, agent_url text, pr_url text, test_result text, summary text, wiring jsonb,
  status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kirk_unmet_intents (
  id text PRIMARY KEY, member_key text NOT NULL, raw_text text NOT NULL, category text,
  attributes jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kirk_purchase_requests (
  id text PRIMARY KEY, intent_id text REFERENCES kirk_unmet_intents(id), member_key text NOT NULL,
  query text NOT NULL, category text, trends jsonb NOT NULL, vendors jsonb NOT NULL,
  status text NOT NULL, decided_by text, decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kirk_preorder_items (
  id text PRIMARY KEY, purchase_request_id text NOT NULL REFERENCES kirk_purchase_requests(id),
  name text NOT NULL, category text, vendor text, description text, image_url text,
  estimated_price numeric(12,2), available boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kirk_preorders (
  id text PRIMARY KEY, item_id text NOT NULL REFERENCES kirk_preorder_items(id),
  member_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kirk_notifications (
  id text PRIMARY KEY, member_key text NOT NULL, title text NOT NULL, body text NOT NULL,
  item_id text, read boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kirk_outbound_mail (
  id text PRIMARY KEY, to_addresses jsonb NOT NULL, subject text NOT NULL, body text NOT NULL,
  provider text NOT NULL, status text NOT NULL, error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_category_idx ON products(category_id);
CREATE INDEX IF NOT EXISTS inventory_product_idx ON inventory(product_id);
CREATE INDEX IF NOT EXISTS orders_member_idx ON orders(member_id);
CREATE INDEX IF NOT EXISTS returns_order_idx ON returns(order_id);
`;

const migrationSql = `
ALTER TABLE members ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount numeric(12,2) NOT NULL DEFAULT 0;
`;

const categorySeed = [
  ["grocery", "Grocery", "Pantry staples, snacks, and beverages"],
  ["electronics", "Electronics", "TVs, computers, audio, and smart home"],
  ["appliances", "Appliances", "Kitchen and laundry appliances"],
  ["furniture", "Furniture", "Furniture for every room"],
  ["home-kitchen", "Home & Kitchen", "Cookware, bedding, and home essentials"],
  ["health-beauty", "Health & Beauty", "Wellness and personal care"],
  ["sports-fitness", "Sports & Fitness", "Outdoor recreation and fitness"],
  ["automotive", "Automotive", "Tires, accessories, and garage supplies"],
  ["clothing", "Clothing", "Apparel and footwear for the family"],
  ["office", "Office", "Office furniture, supplies, and equipment"],
  ["household", "Household", "Paper goods, laundry, cleaning, and everyday warehouse essentials"],
] as const;

const productNames = [
  ["Kirkland Signature Organic Extra Virgin Olive Oil", "Kirkland Signature Almonds", "Starbucks Pike Place K-Cup Pods", "San Pellegrino Sparkling Water", "Nature Valley Crunchy Granola Bars"],
  ["LG 65-inch OLED evo C4 TV", "Apple MacBook Air 13-inch M3", "Sony WH-1000XM5 Headphones", "Samsung Galaxy Tab S9 FE", "Ring Video Doorbell Pro 2"],
  ["KitchenAid 6 Quart Bowl-Lift Mixer", "Dyson V15 Detect Cordless Vacuum", "Ninja Foodi DualZone Air Fryer", "Whirlpool 25 cu ft French Door Refrigerator", "GE Profile Smart Front Load Washer"],
  ["Thomasville Lowell Sectional", "Sealy Posturepedic Queen Mattress", "Bayside Furnishings Writing Desk", "La-Z-Boy Leather Executive Recliner", "Tresanti Adjustable Height Desk"],
  ["Calphalon Premier 12-Piece Cookware Set", "Hotel Signature 800 Thread Count Sheet Set", "Simplehuman Dual Compartment Step Can", "Pyrex 10-Piece Glass Storage Set", "Kohler Pro-Inspired Kitchen Faucet"],
  ["Kirkland Signature Daily Multivitamin", "Philips Sonicare DiamondClean Toothbrush", "Neutrogena Hydro Boost Skincare Set", "Omron Platinum Blood Pressure Monitor", "Conair InfinitiPro Hair Dryer"],
  ["Bowflex SelectTech 552 Dumbbells", "Coleman 8-Person Dark Room Tent", "Callaway Edge 10-Piece Golf Set", "NordicTrack Commercial 1750 Treadmill", "Hydro Flask 32 oz Bottle 2-Pack"],
  ["Michelin Defender2 Tire", "NOCO Boost Plus Jump Starter", "WeatherTech All-Weather Floor Mats", "Armor All Complete Car Care Kit", "Cat 3-in-1 Professional Power Station"],
  ["Jones New York Women's Wool Blend Coat", "Jones New York Men's Merino Wool Sweater", "Adidas Women's Cloudfoam Shoes", "Levi's Men's 505 Regular Jeans", "Jones New York Kids' Fleece Hoodie 2-Pack"],
  ["HP OfficeJet Pro 9125e Printer", "Fellowes Powershred 12-Sheet Shredder", "HON Ignition 2.0 Ergonomic Chair", "Hammermill Copy Paper 10-Ream Case", "Quartet Magnetic Glass Whiteboard"],
] as const;

const warehousesSeed = [
  ["001", "Seattle", "4401 4th Ave S", "Seattle", "WA", "98134", "47.564850", "-122.329500"],
  ["002", "San Francisco", "450 10th St", "San Francisco", "CA", "94103", "37.770300", "-122.410400"],
  ["003", "Los Angeles", "1345 N Montebello Blvd", "Montebello", "CA", "90640", "34.030700", "-118.094500"],
  ["004", "Denver", "400 S Zuni St", "Denver", "CO", "80223", "39.708900", "-105.016600"],
  ["005", "Dallas", "8055 Churchill Way", "Dallas", "TX", "75251", "32.887700", "-96.769600"],
  ["006", "Chicago", "1430 S Ashland Ave", "Chicago", "IL", "60608", "41.862500", "-87.666900"],
  ["007", "New York", "3250 Vernon Blvd", "Long Island City", "NY", "11106", "40.767500", "-73.936500"],
  ["008", "Miami", "7795 W Flagler St", "Miami", "FL", "33144", "25.770700", "-80.322100"],
] as const;

export async function createDatabase(dataDir = process.env.DATABASE_PATH ?? "./data/costco"): Promise<DatabaseContext> {
  if (!dataDir.startsWith("memory://")) await mkdir(dirname(resolve(dataDir)), { recursive: true });
  const client = new PGlite(dataDir);
  await client.waitReady;
  await client.exec(schemaSql);
  await client.exec(migrationSql);
  const db = drizzle(client, { schema });
  const [categoryCount] = await db.select({ total: count() }).from(schema.categories);
  if ((categoryCount?.total ?? 0) === 0) await seedDatabase(db);
  await seedCostcoCatalog(db);
  await ensureOpsSeed(db);
  await ensureKirkSeed(db);
  return { client, db, close: () => client.close() };
}

async function seedDatabase(db: Database): Promise<void> {
  const now = new Date();
  const future = new Date(now.getTime() + 365 * 86_400_000);
  const categoriesRows = categorySeed.map(([slug, name, description], index) => ({
    id: `cat-${index + 1}`,
    slug,
    name,
    description,
    imageUrl: `https://images.unsplash.com/photo-${1500000000000 + index}?auto=format&fit=crop&w=800&q=80`,
  }));
  await db.insert(schema.categories).values(categoriesRows);

  const productsRows = productNames.flatMap((names, categoryIndex) =>
    names.map((name, productIndex) => {
      const index = categoryIndex * 5 + productIndex + 1;
      const price = 9.99 + index * 17.35 + (categoryIndex > 0 ? categoryIndex * 35 : 0);
      return {
        id: `prod-${String(index).padStart(3, "0")}`,
        sku: `CST-${100000 + index}`,
        categoryId: `cat-${categoryIndex + 1}`,
        slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
        name,
        brand: name.split(" ").slice(0, name.startsWith("Kirkland") ? 2 : 1).join(" "),
        description: `${name} delivers warehouse value, dependable quality, and member-friendly satisfaction.`,
        price: price.toFixed(2),
        compareAtPrice: index % 3 === 0 ? (price * 1.15).toFixed(2) : null,
        rating: (4 + (index % 9) / 10).toFixed(1),
        reviewCount: 43 + index * 37,
        featured: index % 7 === 0,
      };
    }),
  );
  await db.insert(schema.products).values(productsRows);
  await db.insert(schema.productMedia).values(productsRows.flatMap((product, index) => [
    { id: `media-${index + 1}-1`, productId: product.id, url: `https://images.unsplash.com/photo-${1510000000000 + index}?auto=format&fit=crop&w=1000&q=85`, alt: product.name, position: 0 },
    { id: `media-${index + 1}-2`, productId: product.id, url: `https://images.unsplash.com/photo-${1520000000000 + index}?auto=format&fit=crop&w=1000&q=85`, alt: `${product.name} detail`, position: 1 },
  ]));
  await db.insert(schema.productSpecs).values(productsRows.flatMap((product, index) => [
    { id: `spec-${index + 1}-1`, productId: product.id, name: "Item number", value: product.sku, position: 0 },
    { id: `spec-${index + 1}-2`, productId: product.id, name: "Warranty", value: index % 2 ? "2 years" : "1 year", position: 1 },
  ]));

  await db.insert(schema.warehouses).values(warehousesSeed.map(([number, name, address1, city, state, zip, latitude, longitude], index) => ({
    id: `wh-${index + 1}`,
    number,
    name: `${name} Warehouse`,
    address1,
    city,
    state,
    zip,
    phone: `(${200 + index}00) 555-01${String(index).padStart(2, "0")}`,
    latitude,
    longitude,
    hours: { weekdays: "10:00 AM–8:30 PM", saturday: "9:30 AM–7:00 PM", sunday: "10:00 AM–6:00 PM" },
    services: ["Gas Station", "Pharmacy", "Optical", ...(index % 2 === 0 ? ["Tire Center"] : [])],
  })));
  await db.insert(schema.inventory).values(warehousesSeed.flatMap((_, warehouseIndex) =>
    productsRows.map((product, productIndex) => ({
      id: `inv-${warehouseIndex + 1}-${productIndex + 1}`,
      warehouseId: `wh-${warehouseIndex + 1}`,
      productId: product.id,
      quantity: (productIndex + warehouseIndex * 3) % 13 === 0 ? 0 : 5 + ((productIndex * 7 + warehouseIndex * 11) % 70),
      aisle: `${String.fromCharCode(65 + (productIndex % 12))}${1 + (productIndex % 24)}`,
    })),
  ));

  const demoMembers = [
    ["member-1", "alex.johnson@example.com", "Alex", "Johnson", "111000000001", "executive"],
    ["member-2", "jamie.chen@example.com", "Jamie", "Chen", "111000000002", "gold_star"],
    ["member-3", "morgan.davis@example.com", "Morgan", "Davis", "111000000003", "executive"],
    ["member-4", "taylor.smith@example.com", "Taylor", "Smith", "111000000004", "business"],
    ["member-5", "casey.martinez@example.com", "Casey", "Martinez", "111000000005", "gold_star"],
  ] as const;
  const passwordHash = await hashPassword("CostcoDemo123!");
  await db.insert(schema.members).values(demoMembers.map(([id, email, , , membershipNumber, membershipTier]) => ({
    id, email, passwordHash, membershipNumber, membershipTier, membershipExpiresAt: future,
  })));
  await db.insert(schema.profiles).values(demoMembers.map(([memberId, , firstName, lastName], index) => ({
    memberId, firstName, lastName, phone: `206-555-10${index + 10}`, marketingOptIn: index % 2 === 0,
  })));
  await db.insert(schema.addresses).values(demoMembers.map(([memberId, , firstName, lastName], index) => ({
    id: `addr-${index + 1}`, memberId, label: "Home", firstName, lastName,
    address1: `${100 + index} Member Lane`, city: "Seattle", state: "WA", zip: `9810${index}`,
    phone: `206-555-10${index + 10}`, isDefault: true,
  })));
  await db.insert(schema.carts).values(demoMembers.map(([memberId], index) => ({
    id: `cart-${index + 1}`, memberId, warehouseId: `wh-${(index % 8) + 1}`, status: "active",
  })));

  const delivered = new Date(now.getTime() - 14 * 86_400_000);
  const oldDelivered = new Date(now.getTime() - 120 * 86_400_000);
  const orderRows = [
    { id: "order-1", orderNumber: "CST-2026-100001", memberId: "member-1", warehouseId: "wh-1", status: "delivered", fulfillmentType: "shipping", subtotal: "357.68", tax: "36.66", total: "394.34", deliveredAt: delivered },
    { id: "order-2", orderNumber: "CST-2026-100002", memberId: "member-1", warehouseId: "wh-1", status: "shipped", fulfillmentType: "shipping", subtotal: "183.49", tax: "18.81", total: "202.30", deliveredAt: null },
    { id: "order-3", orderNumber: "CST-2026-100003", memberId: "member-2", warehouseId: "wh-2", status: "processing", fulfillmentType: "warehouse_pickup", subtotal: "44.69", tax: "4.58", total: "49.27", deliveredAt: null },
    { id: "order-4", orderNumber: "CST-2026-100004", memberId: "member-2", warehouseId: "wh-2", status: "cancelled", fulfillmentType: "shipping", subtotal: "287.59", tax: "29.48", total: "317.07", deliveredAt: null },
    { id: "order-5", orderNumber: "CST-2026-100005", memberId: "member-3", warehouseId: "wh-3", status: "delivered", fulfillmentType: "shipping", subtotal: "79.39", tax: "8.14", total: "87.53", deliveredAt: oldDelivered },
    { id: "order-6", orderNumber: "CST-2026-100006", memberId: "member-3", warehouseId: "wh-3", status: "delivered", fulfillmentType: "warehouse_pickup", subtotal: "131.44", tax: "13.47", total: "144.91", deliveredAt: delivered },
  ].map((order, index) => ({
    ...order,
    shippingAddress: order.fulfillmentType === "shipping" ? { firstName: "Demo", lastName: "Member", address1: "100 Member Lane", city: "Seattle", state: "WA", zip: "98101" } : null,
    payment: { brand: "Visa", last4: String(4242 + index), expMonth: 12, expYear: 2029 },
    placedAt: new Date(now.getTime() - (20 + index * 8) * 86_400_000),
  }));
  await db.insert(schema.orders).values(orderRows);
  const seededOrderItems = orderRows.map((order, index) => {
    const product = productsRows[index]!;
    return {
      id: `oi-${index + 1}`,
      orderId: order.id,
      productId: product.id,
      sku: product.sku,
      name: product.name,
      unitPrice: order.subtotal,
      quantity: 1,
      imageUrl: `https://images.unsplash.com/photo-${1510000000000 + index}?auto=format&fit=crop&w=1000&q=85`,
    };
  });
  await db.insert(schema.orderItems).values([
    ...seededOrderItems,
    {
      id: "oi-7",
      orderId: "order-1",
      productId: productsRows[6]!.id,
      sku: productsRows[6]!.sku,
      name: productsRows[6]!.name,
      unitPrice: productsRows[6]!.price,
      quantity: 2,
      imageUrl: "https://images.unsplash.com/photo-1510000000006?auto=format&fit=crop&w=1000&q=85",
    },
  ]);
  await db.insert(schema.shipments).values([
    { id: "ship-1", orderId: "order-1", carrier: "UPS", trackingNumber: "1ZDEMO000001", status: "delivered", shippedAt: new Date(delivered.getTime() - 3 * 86_400_000), deliveredAt: delivered },
    { id: "ship-2", orderId: "order-2", carrier: "UPS", trackingNumber: "1ZDEMO000002", status: "in_transit", shippedAt: new Date(now.getTime() - 2 * 86_400_000) },
    { id: "ship-5", orderId: "order-5", carrier: "FedEx", trackingNumber: "DEMO000005", status: "delivered", shippedAt: new Date(oldDelivered.getTime() - 4 * 86_400_000), deliveredAt: oldDelivered },
  ]);
  await db.insert(schema.returns).values([
    { id: "return-1", returnNumber: "RET-2026-000001", orderId: "order-1", memberId: "member-1", type: "return", method: "shipping_label", reason: "Changed my mind", status: "label_created", labelUrl: "/demo-labels/RET-2026-000001.pdf" },
    { id: "return-2", returnNumber: "RET-2026-000002", orderId: "order-6", memberId: "member-3", type: "replace", method: "warehouse", warehouseId: "wh-3", reason: "Damaged item", status: "completed" },
  ]);
  await db.insert(schema.returnItems).values([
    { id: "ri-1", returnId: "return-1", orderItemId: "oi-1", quantity: 1, resolution: "refund" },
    { id: "ri-2", returnId: "return-2", orderItemId: "oi-6", quantity: 1, resolution: "replacement" },
  ]);
  await db.insert(schema.returnHistory).values([
    { id: "rh-1", returnId: "return-1", status: "requested", note: "Return request submitted" },
    { id: "rh-2", returnId: "return-1", status: "label_created", note: "Prepaid shipping label generated" },
    { id: "rh-3", returnId: "return-2", status: "requested", note: "Replacement requested at warehouse" },
    { id: "rh-4", returnId: "return-2", status: "completed", note: "Replacement issued" },
  ]);
}

async function ensureOpsSeed(db: Database): Promise<void> {
  const passwordHash = await hashPassword("CostcoDemo123!");
  const staff = [
    ["staff-1", "service@costco.demo", "Priya", "Nair"],
    ["staff-2", "warehouse@costco.demo", "Jordan", "Lee"],
  ] as const;
  for (const [id, email, firstName, lastName] of staff) {
    const [existing] = await db.select({ id: schema.members.id }).from(schema.members).where(eq(schema.members.email, email)).limit(1);
    if (existing) continue;
    await db.insert(schema.members).values({
      id, email, passwordHash, role: "staff", membershipTier: "staff",
    });
    await db.insert(schema.profiles).values({ memberId: id, firstName, lastName, phone: "800-774-2678" });
  }

  const discountCount = await db.select({ total: count() }).from(schema.discounts);
  if ((discountCount[0]?.total ?? 0) > 0) return;
  const [orderOne] = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.id, "order-1")).limit(1);
  await db.insert(schema.discounts).values([
    {
      id: "disc-1", code: "EXEC-COURTESY", name: "Executive courtesy", type: "percent", value: "10.00",
      reason: "Executive member goodwill", status: "active", createdBy: "staff-1", maxUses: 50, usedCount: 1,
      notes: "Up to 10% off remaining balance for service recovery.",
    },
    {
      id: "disc-2", code: "DAMAGE-15", name: "Damaged packaging", type: "amount", value: "15.00",
      reason: "Item arrived with damaged packaging", status: "active", createdBy: "staff-1", usedCount: 0,
      notes: "Flat $15 courtesy for cosmetic packaging issues.",
    },
    {
      id: "disc-3", code: null, name: "Price match override", type: "amount", value: "25.00",
      reason: "Discretionary price match", status: "active", createdBy: "staff-1",       usedCount: orderOne ? 1 : 0,
      notes: "One-off CS override. Require supervisor note on application.",
    },
  ]);
  if (!orderOne) return;
  await db.insert(schema.discountApplications).values({
    id: "da-1", discountId: "disc-3", orderId: "order-1", amount: "25.00",
    appliedBy: "staff-1", reason: "TV advertised $25 lower at a nearby warehouse",
  });
  await db.update(schema.orders).set({ discount: "25.00", total: "369.34", updatedAt: new Date() }).where(eq(schema.orders.id, "order-1"));
}

async function ensureKirkSeed(db: Database): Promise<void> {
  const existing = await db.select({ id: schema.kirkCategoryHeroes.id }).from(schema.kirkCategoryHeroes).limit(1);
  if (existing.length) return;
  const placeholders: Record<string, string> = {
    grocery: "/images/category-1.svg",
    household: "/images/category-2.svg",
    electronics: "/images/category-3.svg",
    furniture: "/images/category-4.svg",
    outdoor: "/images/category-5.svg",
  };
  await db.insert(schema.kirkCategoryHeroes).values(kirkMembers.categories.map((category) => ({
    id: `hero-${category.id}`,
    category: category.id,
    label: category.label,
    prompt: category.prompt,
    imageUrl: placeholders[category.id] ?? "/images/category-1.svg",
    source: "placeholder",
  })));
}

export async function resetDatabase(dataDir = process.env.DATABASE_PATH ?? "./data/costco"): Promise<void> {
  if (dataDir.startsWith("memory://")) return;
  await rm(resolve(dataDir), { recursive: true, force: true });
  const context = await createDatabase(dataDir);
  await context.close();
}
