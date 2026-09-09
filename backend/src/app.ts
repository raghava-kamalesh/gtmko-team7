import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, ilike, inArray, or, sql } from "drizzle-orm";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { type DatabaseContext } from "./db.js";
import {
  addresses,
  cartItems,
  carts,
  categories,
  discountApplications,
  discounts,
  inventory,
  type Member,
  members,
  orderItems,
  orders,
  productMedia,
  products,
  productSpecs,
  profiles,
  returnHistory,
  returnItems,
  returns,
  sessions,
  shipments,
  warehouses,
} from "./schema.js";
import { AssistantError, runAssistantTurn } from "./grok.js";
import { createSessionToken, hashPassword, hashToken, verifyPassword } from "./security.js";

type Variables = { member: Member; tokenHash: string };
type AppContext = Context<{ Variables: Variables }>;

class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 502 | 503,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const data = <T>(value: T, meta?: Record<string, unknown>) => ({ data: value, ...(meta ? { meta } : {}) });
const money = (value: string | number) => Number(Number(value).toFixed(2));
const asPositiveInt = (value: unknown, field: string, max = 99) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new ApiError(422, "VALIDATION_ERROR", `${field} must be an integer between 1 and ${max}`);
  }
  return parsed;
};

async function body(c: AppContext): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await c.req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be a JSON object");
  }
}

const publicMember = (member: Member, profile?: typeof profiles.$inferSelect | null) => ({
  id: member.id,
  email: member.email,
  role: member.role ?? "member",
  membershipNumber: member.membershipNumber,
  membershipTier: member.membershipTier,
  membershipExpiresAt: member.membershipExpiresAt,
  profile: profile
    ? {
        firstName: profile.firstName,
        lastName: profile.lastName,
        phone: profile.phone,
        marketingOptIn: profile.marketingOptIn,
      }
    : null,
});

const zipWarehouse = (zip: string) => {
  const first = Number(zip[0]);
  if (first <= 1) return "wh-7";
  if (first <= 3) return "wh-8";
  if (first <= 5) return "wh-6";
  if (first <= 6) return "wh-5";
  if (first === 7) return "wh-4";
  if (first === 8) return "wh-3";
  return "wh-1";
};

export function createApp(context: DatabaseContext) {
  const { db } = context;
  const app = new Hono<{ Variables: Variables }>();

  app.use("*", cors({
    origin: (origin) => {
      if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
      return (process.env.CORS_ORIGIN ?? "http://localhost:5173").split(",")[0] ?? "http://localhost:5173";
    },
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization", "X-Guest-Cart-Id"],
    exposeHeaders: ["X-Guest-Cart-Id"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  }));

  const authenticate: MiddlewareHandler<{ Variables: Variables }> = async (c, next) => {
    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) throw new ApiError(401, "AUTH_REQUIRED", "A bearer session is required");
    const tokenHash = hashToken(header.slice(7));
    const [result] = await db
      .select({ session: sessions, member: members })
      .from(sessions)
      .innerJoin(members, eq(sessions.memberId, members.id))
      .where(and(eq(sessions.tokenHash, tokenHash), gte(sessions.expiresAt, new Date())))
      .limit(1);
    if (!result) throw new ApiError(401, "INVALID_SESSION", "Session is invalid or expired");
    c.set("member", result.member);
    c.set("tokenHash", tokenHash);
    await next();
  };

  const requireStaff: MiddlewareHandler<{ Variables: Variables }> = async (c, next) => {
    if ((c.get("member").role ?? "member") !== "staff") {
      throw new ApiError(403, "STAFF_REQUIRED", "Customer service staff access is required");
    }
    await next();
  };

  async function memberFromOptionalAuth(c: AppContext): Promise<Member | null> {
    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) return null;
    const [result] = await db
      .select({ member: members })
      .from(sessions)
      .innerJoin(members, eq(sessions.memberId, members.id))
      .where(and(eq(sessions.tokenHash, hashToken(header.slice(7))), gte(sessions.expiresAt, new Date())))
      .limit(1);
    if (!result) throw new ApiError(401, "INVALID_SESSION", "Session is invalid or expired");
    return result.member;
  }

  async function findCart(c: AppContext, create = true) {
    const member = await memberFromOptionalAuth(c);
    const guestToken = c.req.header("X-Guest-Cart-Id");
    let cart: typeof carts.$inferSelect | undefined;
    if (member) {
      [cart] = await db.select().from(carts).where(and(eq(carts.memberId, member.id), eq(carts.status, "active"))).limit(1);
      if (!cart && create) {
        [cart] = await db.insert(carts).values({ id: randomUUID(), memberId: member.id, status: "active" }).returning();
      }
    } else if (guestToken) {
      [cart] = await db.select().from(carts).where(and(eq(carts.guestToken, guestToken), eq(carts.status, "active"))).limit(1);
      if (!cart) throw new ApiError(404, "GUEST_CART_NOT_FOUND", "Guest cart was not found");
    } else {
      throw new ApiError(401, "CART_IDENTITY_REQUIRED", "Sign in or provide X-Guest-Cart-Id");
    }
    if (!cart) throw new ApiError(404, "CART_NOT_FOUND", "Cart was not found");
    return cart;
  }

  async function serializeCart(cart: typeof carts.$inferSelect) {
    const rows = await db
      .select({ item: cartItems, product: products, mediaUrl: productMedia.url })
      .from(cartItems)
      .innerJoin(products, eq(cartItems.productId, products.id))
      .leftJoin(productMedia, and(eq(productMedia.productId, products.id), eq(productMedia.position, 0)))
      .where(eq(cartItems.cartId, cart.id))
      .orderBy(asc(cartItems.createdAt));
    const items = rows.map(({ item, product, mediaUrl }) => ({
      id: item.id,
      productId: product.id,
      sku: product.sku,
      name: product.name,
      imageUrl: mediaUrl,
      unitPrice: money(product.price),
      quantity: item.quantity,
      lineTotal: money(Number(product.price) * item.quantity),
    }));
    const subtotal = money(items.reduce((sum, item) => sum + item.lineTotal, 0));
    return {
      id: cart.id,
      guestCartId: cart.guestToken,
      warehouseId: cart.warehouseId,
      items,
      itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
      subtotal,
    };
  }

  async function mergeGuestCart(memberId: string, guestToken?: string) {
    if (!guestToken) return;
    const [guestCart] = await db.select().from(carts).where(and(eq(carts.guestToken, guestToken), eq(carts.status, "active"))).limit(1);
    if (!guestCart) return;
    let [memberCart] = await db.select().from(carts).where(and(eq(carts.memberId, memberId), eq(carts.status, "active"))).limit(1);
    if (!memberCart) {
      [memberCart] = await db.insert(carts).values({ id: randomUUID(), memberId, warehouseId: guestCart.warehouseId, status: "active" }).returning();
    }
    const guestItems = await db.select().from(cartItems).where(eq(cartItems.cartId, guestCart.id));
    for (const item of guestItems) {
      const [existing] = await db.select().from(cartItems).where(and(eq(cartItems.cartId, memberCart.id), eq(cartItems.productId, item.productId))).limit(1);
      if (existing) {
        await db.update(cartItems).set({ quantity: Math.min(99, existing.quantity + item.quantity), updatedAt: new Date() }).where(eq(cartItems.id, existing.id));
      } else {
        await db.insert(cartItems).values({ id: randomUUID(), cartId: memberCart.id, productId: item.productId, quantity: item.quantity });
      }
    }
    await db.update(carts).set({ status: "merged", updatedAt: new Date() }).where(eq(carts.id, guestCart.id));
  }

  async function issueSession(member: Member) {
    const sessionToken = createSessionToken();
    const ttl = Number(process.env.SESSION_TTL_DAYS ?? 30);
    const expiresAt = new Date(Date.now() + ttl * 86_400_000);
    await db.insert(sessions).values({ id: randomUUID(), memberId: member.id, tokenHash: sessionToken.hash, expiresAt });
    const [profile] = await db.select().from(profiles).where(eq(profiles.memberId, member.id)).limit(1);
    return { token: sessionToken.token, expiresAt, member: publicMember(member, profile) };
  }

  async function serializeOrder(order: typeof orders.$inferSelect, expanded = false) {
    const base = {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      fulfillmentType: order.fulfillmentType,
      warehouseId: order.warehouseId,
      subtotal: money(order.subtotal),
      tax: money(order.tax),
      discount: money(order.discount ?? 0),
      total: money(order.total),
      payment: order.payment,
      shippingAddress: order.shippingAddress,
      placedAt: order.placedAt,
      deliveredAt: order.deliveredAt,
    };
    if (!expanded) return base;
    const [items, shipmentRows, returnRows] = await Promise.all([
      db.select().from(orderItems).where(eq(orderItems.orderId, order.id)),
      db.select().from(shipments).where(eq(shipments.orderId, order.id)),
      db.select().from(returns).where(eq(returns.orderId, order.id)),
    ]);
    return {
      ...base,
      items: items.map((item) => ({ ...item, unitPrice: money(item.unitPrice) })),
      shipments: shipmentRows,
      returns: returnRows,
    };
  }

  async function serializeReturn(record: typeof returns.$inferSelect) {
    const [items, history] = await Promise.all([
      db
        .select({ id: returnItems.id, orderItemId: returnItems.orderItemId, quantity: returnItems.quantity, resolution: returnItems.resolution, productName: orderItems.name })
        .from(returnItems)
        .innerJoin(orderItems, eq(returnItems.orderItemId, orderItems.id))
        .where(eq(returnItems.returnId, record.id)),
      db.select().from(returnHistory).where(eq(returnHistory.returnId, record.id)).orderBy(asc(returnHistory.createdAt)),
    ]);
    return { ...record, items, history };
  }

  app.get("/health", (c) => c.json(data({ status: "ok", database: "ready", timestamp: new Date().toISOString() })));

  app.post("/assistant/chat", async (c) => {
    const input = await body(c);
    if (!Array.isArray(input.messages) || input.messages.length === 0 || input.messages.length > 40) {
      throw new ApiError(422, "VALIDATION_ERROR", "messages must be a non-empty array of at most 40 turns");
    }
    const messages = input.messages.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new ApiError(422, "VALIDATION_ERROR", `messages[${index}] must be an object`);
      }
      const row = item as Record<string, unknown>;
      const role = row.role;
      const content = String(row.content ?? row.text ?? "").trim();
      if (role !== "user" && role !== "assistant") {
        throw new ApiError(422, "VALIDATION_ERROR", `messages[${index}].role must be user or assistant`);
      }
      if (!content || content.length > 4000) {
        throw new ApiError(422, "VALIDATION_ERROR", `messages[${index}].content must be 1–4000 characters`);
      }
      return { role: role as "user" | "assistant", content };
    });
    const warehouseInput = input.warehouse && typeof input.warehouse === "object" && !Array.isArray(input.warehouse)
      ? input.warehouse as Record<string, unknown>
      : {};
    try {
      return c.json(data(await runAssistantTurn({
        messages,
        warehouse: {
          id: String(warehouseInput.id ?? "w1"),
          name: String(warehouseInput.name ?? "Warehouse"),
        },
      })));
    } catch (error) {
      if (error instanceof AssistantError) {
        throw new ApiError(error.status, error.code, error.message);
      }
      throw error;
    }
  });

  app.get("/warehouses", async (c) => {
    const query = c.req.query("q")?.trim();
    const state = c.req.query("state")?.trim().toUpperCase();
    const zip = c.req.query("zip")?.trim();
    const conditions = [
      query ? or(ilike(warehouses.name, `%${query}%`), ilike(warehouses.city, `%${query}%`), ilike(warehouses.zip, `%${query}%`)) : undefined,
      state ? eq(warehouses.state, state) : undefined,
      zip ? ilike(warehouses.zip, `${zip}%`) : undefined,
    ].filter(Boolean);
    const rows = await db.select().from(warehouses).where(conditions.length ? and(...conditions as ReturnType<typeof eq>[]) : undefined).orderBy(asc(warehouses.state), asc(warehouses.city));
    return c.json(data(rows, { count: rows.length }));
  });

  app.get("/warehouses/:id", async (c) => {
    const [warehouse] = await db.select().from(warehouses).where(eq(warehouses.id, c.req.param("id"))).limit(1);
    if (!warehouse) throw new ApiError(404, "WAREHOUSE_NOT_FOUND", "Warehouse was not found");
    const [{ stocked, units }] = await db
      .select({ stocked: sql<number>`count(*) filter (where ${inventory.quantity} > 0)::int`, units: sql<number>`coalesce(sum(${inventory.quantity}), 0)::int` })
      .from(inventory)
      .where(eq(inventory.warehouseId, warehouse.id));
    return c.json(data({ ...warehouse, inventorySummary: { stockedProducts: stocked, totalUnits: units } }));
  });

  app.get("/categories", async (c) => {
    const rows = await db
      .select({ category: categories, productCount: sql<number>`count(${products.id})::int` })
      .from(categories)
      .leftJoin(products, and(eq(products.categoryId, categories.id), eq(products.active, true)))
      .groupBy(categories.id)
      .orderBy(asc(categories.name));
    return c.json(data(rows.map(({ category, productCount }) => ({ ...category, productCount }))));
  });

  app.get("/products", async (c) => {
    const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
    const pageSize = Math.min(50, Math.max(1, Number.parseInt(c.req.query("pageSize") ?? "20", 10) || 20));
    const search = c.req.query("search")?.trim();
    const category = c.req.query("category")?.trim();
    const warehouseId = c.req.query("warehouseId")?.trim() || (c.req.query("deliveryZip") ? zipWarehouse(c.req.query("deliveryZip")!) : undefined);
    const stockOnly = c.req.query("inStock") === "true";
    const conditions = [
      eq(products.active, true),
      search ? or(ilike(products.name, `%${search}%`), ilike(products.brand, `%${search}%`), ilike(products.description, `%${search}%`)) : undefined,
      category ? or(eq(categories.slug, category), eq(categories.id, category)) : undefined,
      stockOnly ? sql`${inventory.quantity} > 0` : undefined,
    ].filter(Boolean);
    const sort = c.req.query("sort") ?? "featured";
    const orderBy = sort === "price_asc" ? asc(products.price)
      : sort === "price_desc" ? desc(products.price)
      : sort === "rating" ? desc(products.rating)
      : sort === "name" ? asc(products.name)
      : desc(products.featured);
    const stockExpression = warehouseId
      ? sql<number>`coalesce(max(${inventory.quantity}) filter (where ${inventory.warehouseId} = ${warehouseId}), 0)::int`
      : sql<number>`coalesce(sum(${inventory.quantity}), 0)::int`;
    const queryBase = db
      .select({
        product: products,
        categoryName: categories.name,
        categorySlug: categories.slug,
        imageUrl: sql<string | null>`min(${productMedia.url}) filter (where ${productMedia.position} = 0)`,
        stock: stockExpression,
      })
      .from(products)
      .innerJoin(categories, eq(products.categoryId, categories.id))
      .leftJoin(productMedia, eq(productMedia.productId, products.id))
      .leftJoin(inventory, and(eq(inventory.productId, products.id), warehouseId ? eq(inventory.warehouseId, warehouseId) : undefined))
      .where(and(...conditions as ReturnType<typeof eq>[]))
      .groupBy(products.id, categories.id)
      .orderBy(orderBy)
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const countRows = await db
      .select({ id: products.id })
      .from(products)
      .innerJoin(categories, eq(products.categoryId, categories.id))
      .leftJoin(inventory, and(eq(inventory.productId, products.id), warehouseId ? eq(inventory.warehouseId, warehouseId) : undefined))
      .where(and(...conditions as ReturnType<typeof eq>[]))
      .groupBy(products.id);
    const rows = await queryBase;
    const result = rows.map(({ product, categoryName, categorySlug, imageUrl, stock }) => ({
      ...product,
      price: money(product.price),
      compareAtPrice: product.compareAtPrice ? money(product.compareAtPrice) : null,
      rating: Number(product.rating),
      category: { id: product.categoryId, name: categoryName, slug: categorySlug },
      imageUrl,
      inventory: { warehouseId: warehouseId ?? null, quantity: stock, inStock: stock > 0 },
    }));
    return c.json(data(result, { page, pageSize, total: countRows.length, totalPages: Math.ceil(countRows.length / pageSize), resolvedWarehouseId: warehouseId ?? null }));
  });

  app.get("/products/:id", async (c) => {
    const identifier = c.req.param("id");
    const [row] = await db
      .select({ product: products, category: categories })
      .from(products)
      .innerJoin(categories, eq(products.categoryId, categories.id))
      .where(and(eq(products.active, true), or(eq(products.id, identifier), eq(products.slug, identifier))))
      .limit(1);
    if (!row) throw new ApiError(404, "PRODUCT_NOT_FOUND", "Product was not found");
    const [media, specs, stock] = await Promise.all([
      db.select().from(productMedia).where(eq(productMedia.productId, row.product.id)).orderBy(asc(productMedia.position)),
      db.select().from(productSpecs).where(eq(productSpecs.productId, row.product.id)).orderBy(asc(productSpecs.position)),
      db
        .select({ warehouseId: inventory.warehouseId, warehouseName: warehouses.name, quantity: inventory.quantity, aisle: inventory.aisle })
        .from(inventory)
        .innerJoin(warehouses, eq(inventory.warehouseId, warehouses.id))
        .where(eq(inventory.productId, row.product.id)),
    ]);
    return c.json(data({
      ...row.product,
      price: money(row.product.price),
      compareAtPrice: row.product.compareAtPrice ? money(row.product.compareAtPrice) : null,
      rating: Number(row.product.rating),
      category: row.category,
      media,
      specs,
      inventory: stock.map((item) => ({ ...item, inStock: item.quantity > 0 })),
    }));
  });

  app.post("/auth/register", async (c) => {
    const input = await body(c);
    const email = String(input.email ?? "").trim().toLowerCase();
    const password = String(input.password ?? "");
    const firstName = String(input.firstName ?? "").trim();
    const lastName = String(input.lastName ?? "").trim();
    const membershipNumber = input.membershipNumber ? String(input.membershipNumber).trim() : null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10 || !firstName || !lastName) {
      throw new ApiError(422, "VALIDATION_ERROR", "Valid email, firstName, lastName, and password of at least 10 characters are required");
    }
    const [existing] = await db.select({ id: members.id }).from(members).where(or(eq(members.email, email), membershipNumber ? eq(members.membershipNumber, membershipNumber) : undefined)).limit(1);
    if (existing) throw new ApiError(409, "MEMBER_EXISTS", "Email or membership number is already registered");
    const memberId = randomUUID();
    const [member] = await db.insert(members).values({
      id: memberId,
      email,
      passwordHash: await hashPassword(password),
      membershipNumber,
      membershipTier: "gold_star",
      membershipExpiresAt: new Date(Date.now() + 365 * 86_400_000),
    }).returning();
    await db.insert(profiles).values({ memberId, firstName, lastName });
    await mergeGuestCart(memberId, String(input.guestCartId ?? c.req.header("X-Guest-Cart-Id") ?? "") || undefined);
    return c.json(data(await issueSession(member!)), 201);
  });

  app.post("/auth/login", async (c) => {
    const input = await body(c);
    const email = String(input.email ?? "").trim().toLowerCase();
    const password = String(input.password ?? "");
    const [member] = await db.select().from(members).where(eq(members.email, email)).limit(1);
    if (!member || !(await verifyPassword(password, member.passwordHash))) {
      throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
    }
    await mergeGuestCart(member.id, String(input.guestCartId ?? c.req.header("X-Guest-Cart-Id") ?? "") || undefined);
    return c.json(data(await issueSession(member)));
  });

  app.post("/auth/logout", authenticate, async (c) => {
    await db.delete(sessions).where(eq(sessions.tokenHash, c.get("tokenHash")));
    return c.body(null, 204);
  });

  app.get("/me", authenticate, async (c) => {
    const member = c.get("member");
    const [profile] = await db.select().from(profiles).where(eq(profiles.memberId, member.id)).limit(1);
    const memberAddresses = await db.select().from(addresses).where(eq(addresses.memberId, member.id)).orderBy(desc(addresses.isDefault));
    return c.json(data({ ...publicMember(member, profile), addresses: memberAddresses }));
  });

  app.patch("/me/profile", authenticate, async (c) => {
    const input = await body(c);
    const allowed = {
      ...(typeof input.firstName === "string" && input.firstName.trim() ? { firstName: input.firstName.trim() } : {}),
      ...(typeof input.lastName === "string" && input.lastName.trim() ? { lastName: input.lastName.trim() } : {}),
      ...(typeof input.phone === "string" ? { phone: input.phone.trim() || null } : {}),
      ...(typeof input.marketingOptIn === "boolean" ? { marketingOptIn: input.marketingOptIn } : {}),
      updatedAt: new Date(),
    };
    const [profile] = await db.update(profiles).set(allowed).where(eq(profiles.memberId, c.get("member").id)).returning();
    return c.json(data(publicMember(c.get("member"), profile)));
  });

  app.post("/cart/guest", async (c) => {
    const guestToken = randomUUID();
    const [cart] = await db.insert(carts).values({ id: randomUUID(), guestToken, status: "active" }).returning();
    c.header("X-Guest-Cart-Id", guestToken);
    return c.json(data(await serializeCart(cart!)), 201);
  });

  app.get("/cart", async (c) => c.json(data(await serializeCart(await findCart(c)))));

  app.post("/cart/items", async (c) => {
    const input = await body(c);
    const quantity = asPositiveInt(input.quantity ?? 1, "quantity");
    const productId = String(input.productId ?? "");
    const [product] = await db.select().from(products).where(and(eq(products.id, productId), eq(products.active, true))).limit(1);
    if (!product) throw new ApiError(404, "PRODUCT_NOT_FOUND", "Product was not found");
    const cart = await findCart(c);
    const warehouseId = input.warehouseId ? String(input.warehouseId) : cart.warehouseId;
    if (warehouseId) {
      const [stock] = await db.select().from(inventory).where(and(eq(inventory.productId, productId), eq(inventory.warehouseId, warehouseId))).limit(1);
      if (!stock || stock.quantity < quantity) throw new ApiError(409, "INSUFFICIENT_STOCK", "Requested quantity is not available at this warehouse", { available: stock?.quantity ?? 0 });
      if (cart.warehouseId !== warehouseId) await db.update(carts).set({ warehouseId, updatedAt: new Date() }).where(eq(carts.id, cart.id));
    }
    const [existing] = await db.select().from(cartItems).where(and(eq(cartItems.cartId, cart.id), eq(cartItems.productId, productId))).limit(1);
    if (existing) {
      await db.update(cartItems).set({ quantity: Math.min(99, existing.quantity + quantity), updatedAt: new Date() }).where(eq(cartItems.id, existing.id));
    } else {
      await db.insert(cartItems).values({ id: randomUUID(), cartId: cart.id, productId, quantity });
    }
    return c.json(data(await serializeCart({ ...cart, warehouseId })), 201);
  });

  app.patch("/cart/items/:itemId", async (c) => {
    const input = await body(c);
    const quantity = asPositiveInt(input.quantity, "quantity");
    const cart = await findCart(c);
    const [item] = await db.select().from(cartItems).where(and(eq(cartItems.id, c.req.param("itemId")), eq(cartItems.cartId, cart.id))).limit(1);
    if (!item) throw new ApiError(404, "CART_ITEM_NOT_FOUND", "Cart item was not found");
    if (cart.warehouseId) {
      const [stock] = await db.select().from(inventory).where(and(eq(inventory.productId, item.productId), eq(inventory.warehouseId, cart.warehouseId))).limit(1);
      if (!stock || stock.quantity < quantity) throw new ApiError(409, "INSUFFICIENT_STOCK", "Requested quantity is not available", { available: stock?.quantity ?? 0 });
    }
    await db.update(cartItems).set({ quantity, updatedAt: new Date() }).where(eq(cartItems.id, item.id));
    return c.json(data(await serializeCart(cart)));
  });

  app.delete("/cart/items/:itemId", async (c) => {
    const cart = await findCart(c);
    const removed = await db.delete(cartItems).where(and(eq(cartItems.id, c.req.param("itemId")), eq(cartItems.cartId, cart.id))).returning();
    if (!removed.length) throw new ApiError(404, "CART_ITEM_NOT_FOUND", "Cart item was not found");
    return c.json(data(await serializeCart(cart)));
  });

  app.post("/checkout", authenticate, async (c) => {
    const input = await body(c);
    const member = c.get("member");
    const warehouseId = String(input.warehouseId ?? "");
    const fulfillmentType = String(input.fulfillmentType ?? "shipping");
    if (!["shipping", "warehouse_pickup"].includes(fulfillmentType)) throw new ApiError(422, "VALIDATION_ERROR", "fulfillmentType must be shipping or warehouse_pickup");
    const payment = input.payment as Record<string, unknown> | undefined;
    if (!payment || payment.cvc || payment.cardNumber || !/^\d{4}$/.test(String(payment.last4 ?? ""))) {
      throw new ApiError(422, "INVALID_PAYMENT_METADATA", "Only brand, last4, expMonth, and expYear payment metadata is accepted");
    }
    const [warehouse] = await db.select().from(warehouses).where(eq(warehouses.id, warehouseId)).limit(1);
    if (!warehouse) throw new ApiError(404, "WAREHOUSE_NOT_FOUND", "Warehouse was not found");
    const [cart] = await db.select().from(carts).where(and(eq(carts.memberId, member.id), eq(carts.status, "active"))).limit(1);
    if (!cart) throw new ApiError(409, "EMPTY_CART", "Cart is empty");
    const items = await db
      .select({ item: cartItems, product: products, imageUrl: productMedia.url })
      .from(cartItems)
      .innerJoin(products, eq(cartItems.productId, products.id))
      .leftJoin(productMedia, and(eq(productMedia.productId, products.id), eq(productMedia.position, 0)))
      .where(eq(cartItems.cartId, cart.id));
    if (!items.length) throw new ApiError(409, "EMPTY_CART", "Cart is empty");
    if (fulfillmentType === "shipping" && (!input.shippingAddress || typeof input.shippingAddress !== "object")) {
      throw new ApiError(422, "SHIPPING_ADDRESS_REQUIRED", "A shipping address is required");
    }
    const subtotal = money(items.reduce((sum, row) => sum + Number(row.product.price) * row.item.quantity, 0));
    const tax = money(subtotal * 0.1025);
    const total = money(subtotal + tax);
    const order = await db.transaction(async (tx) => {
      for (const row of items) {
        const decremented = await tx
          .update(inventory)
          .set({ quantity: sql`${inventory.quantity} - ${row.item.quantity}`, updatedAt: new Date() })
          .where(and(eq(inventory.warehouseId, warehouseId), eq(inventory.productId, row.product.id), gte(inventory.quantity, row.item.quantity)))
          .returning({ quantity: inventory.quantity });
        if (!decremented.length) {
          throw new ApiError(409, "INSUFFICIENT_STOCK", `${row.product.name} is no longer available in the requested quantity`);
        }
      }
      const orderId = randomUUID();
      const orderNumber = `CST-${new Date().getUTCFullYear()}-${String(Date.now()).slice(-8)}`;
      const [created] = await tx.insert(orders).values({
        id: orderId,
        orderNumber,
        memberId: member.id,
        warehouseId,
        status: fulfillmentType === "shipping" ? "processing" : "readying_for_pickup",
        fulfillmentType,
        subtotal: subtotal.toFixed(2),
        tax: tax.toFixed(2),
        total: total.toFixed(2),
        shippingAddress: fulfillmentType === "shipping" ? input.shippingAddress : null,
        payment: {
          brand: String(payment.brand ?? "Card"),
          last4: String(payment.last4),
          expMonth: Number(payment.expMonth),
          expYear: Number(payment.expYear),
        },
      }).returning();
      await tx.insert(orderItems).values(items.map((row) => ({
        id: randomUUID(),
        orderId,
        productId: row.product.id,
        sku: row.product.sku,
        name: row.product.name,
        unitPrice: row.product.price,
        quantity: row.item.quantity,
        imageUrl: row.imageUrl,
      })));
      if (fulfillmentType === "shipping") {
        await tx.insert(shipments).values({ id: randomUUID(), orderId, status: "preparing" });
      }
      await tx.update(carts).set({ status: "checked_out", updatedAt: new Date() }).where(eq(carts.id, cart.id));
      return created!;
    });
    return c.json(data({ confirmation: { orderNumber: order.orderNumber, status: order.status }, order: await serializeOrder(order, true) }), 201);
  });

  app.get("/orders", authenticate, async (c) => {
    const rows = await db.select().from(orders).where(eq(orders.memberId, c.get("member").id)).orderBy(desc(orders.placedAt));
    return c.json(data(await Promise.all(rows.map((order) => serializeOrder(order))), { count: rows.length }));
  });

  app.get("/orders/:id", authenticate, async (c) => {
    const identifier = c.req.param("id");
    const [order] = await db.select().from(orders).where(and(eq(orders.memberId, c.get("member").id), or(eq(orders.id, identifier), eq(orders.orderNumber, identifier)))).limit(1);
    if (!order) throw new ApiError(404, "ORDER_NOT_FOUND", "Order was not found");
    return c.json(data(await serializeOrder(order, true)));
  });

  app.get("/orders/:id/returns", authenticate, async (c) => {
    const [order] = await db.select().from(orders).where(and(eq(orders.id, c.req.param("id")), eq(orders.memberId, c.get("member").id))).limit(1);
    if (!order) throw new ApiError(404, "ORDER_NOT_FOUND", "Order was not found");
    const rows = await db.select().from(returns).where(eq(returns.orderId, order.id)).orderBy(desc(returns.createdAt));
    return c.json(data(await Promise.all(rows.map(serializeReturn))));
  });

  app.post("/orders/:id/returns", authenticate, async (c) => {
    const input = await body(c);
    const member = c.get("member");
    const [order] = await db.select().from(orders).where(and(eq(orders.id, c.req.param("id")), eq(orders.memberId, member.id))).limit(1);
    if (!order) throw new ApiError(404, "ORDER_NOT_FOUND", "Order was not found");
    if (order.status !== "delivered" || !order.deliveredAt) throw new ApiError(409, "ORDER_NOT_RETURNABLE", "Only delivered orders can be returned or replaced");
    if (Date.now() - order.deliveredAt.getTime() > 90 * 86_400_000) throw new ApiError(409, "RETURN_WINDOW_EXPIRED", "The 90-day return window has expired");
    const type = String(input.type ?? "");
    const method = String(input.method ?? "");
    const reason = String(input.reason ?? "").trim();
    if (!["return", "replace"].includes(type) || !["warehouse", "shipping_label"].includes(method) || !reason) {
      throw new ApiError(422, "VALIDATION_ERROR", "type, method, and reason are required and must use supported values");
    }
    if (method === "warehouse") {
      const [warehouse] = await db.select().from(warehouses).where(eq(warehouses.id, String(input.warehouseId ?? ""))).limit(1);
      if (!warehouse) throw new ApiError(422, "WAREHOUSE_REQUIRED", "A valid warehouseId is required for warehouse returns");
    }
    const requestedItems = Array.isArray(input.items) ? input.items as Array<Record<string, unknown>> : [];
    if (!requestedItems.length) throw new ApiError(422, "RETURN_ITEMS_REQUIRED", "At least one return item is required");
    const orderItemRows = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    const orderItemMap = new Map(orderItemRows.map((item) => [item.id, item]));
    const itemIds = requestedItems.map((item) => String(item.orderItemId ?? ""));
    const existingQuantities = itemIds.length
      ? await db
          .select({
            orderItemId: returnItems.orderItemId,
            quantity: sql<number>`coalesce(sum(${returnItems.quantity}), 0)::int`,
          })
          .from(returnItems)
          .innerJoin(returns, eq(returnItems.returnId, returns.id))
          .where(and(inArray(returnItems.orderItemId, itemIds), sql`${returns.status} not in ('rejected', 'cancelled')`))
          .groupBy(returnItems.orderItemId)
      : [];
    const alreadyRequested = new Map(existingQuantities.map((item) => [item.orderItemId, item.quantity]));
    const normalized = requestedItems.map((item) => {
      const orderItemId = String(item.orderItemId ?? "");
      const orderItem = orderItemMap.get(orderItemId);
      if (!orderItem) throw new ApiError(422, "INVALID_RETURN_ITEM", "Return item does not belong to this order");
      const quantity = asPositiveInt(item.quantity, "quantity", orderItem.quantity);
      if (quantity + (alreadyRequested.get(orderItemId) ?? 0) > orderItem.quantity) {
        throw new ApiError(409, "DUPLICATE_RETURN", "Requested quantity has already been included in another return");
      }
      return { orderItemId, quantity };
    });
    const record = await db.transaction(async (tx) => {
      const id = randomUUID();
      const returnNumber = `RET-${new Date().getUTCFullYear()}-${String(Date.now()).slice(-8)}`;
      const status = method === "shipping_label" ? "label_created" : "requested";
      const [created] = await tx.insert(returns).values({
        id,
        returnNumber,
        orderId: order.id,
        memberId: member.id,
        type,
        method,
        warehouseId: method === "warehouse" ? String(input.warehouseId) : null,
        reason,
        status,
        labelUrl: method === "shipping_label" ? `/demo-labels/${returnNumber}.pdf` : null,
      }).returning();
      await tx.insert(returnItems).values(normalized.map((item) => ({
        id: randomUUID(),
        returnId: id,
        orderItemId: item.orderItemId,
        quantity: item.quantity,
        resolution: type === "replace" ? "replacement" : "refund",
      })));
      await tx.insert(returnHistory).values([
        { id: randomUUID(), returnId: id, status: "requested", note: `${type === "replace" ? "Replacement" : "Return"} request submitted` },
        ...(status === "label_created" ? [{ id: randomUUID(), returnId: id, status, note: "Prepaid shipping label generated" }] : []),
      ]);
      return created!;
    });
    return c.json(data(await serializeReturn(record)), 201);
  });

  const orderStatuses = ["processing", "readying_for_pickup", "shipped", "delivered", "cancelled"] as const;
  const returnStatuses = ["requested", "label_created", "received", "approved", "completed", "rejected", "cancelled"] as const;

  async function adminOrderPayload(order: typeof orders.$inferSelect, expanded = false) {
    const [member] = await db.select().from(members).where(eq(members.id, order.memberId)).limit(1);
    const [profile] = await db.select().from(profiles).where(eq(profiles.memberId, order.memberId)).limit(1);
    const [warehouse] = await db.select().from(warehouses).where(eq(warehouses.id, order.warehouseId)).limit(1);
    const applications = await db
      .select({
        id: discountApplications.id,
        amount: discountApplications.amount,
        reason: discountApplications.reason,
        createdAt: discountApplications.createdAt,
        discountName: discounts.name,
        discountCode: discounts.code,
      })
      .from(discountApplications)
      .innerJoin(discounts, eq(discountApplications.discountId, discounts.id))
      .where(eq(discountApplications.orderId, order.id));
    return {
      ...(await serializeOrder(order, expanded)),
      member: member
        ? {
            id: member.id,
            email: member.email,
            name: profile ? `${profile.firstName} ${profile.lastName}` : member.email,
            membershipNumber: member.membershipNumber,
          }
        : null,
      warehouse: warehouse ? { id: warehouse.id, name: warehouse.name, city: warehouse.city, state: warehouse.state } : null,
      discounts: applications.map((row) => ({ ...row, amount: money(row.amount) })),
    };
  }

  app.post("/auth/staff-login", async (c) => {
    const input = await body(c);
    const email = String(input.email ?? "").trim().toLowerCase();
    const password = String(input.password ?? "");
    const [member] = await db.select().from(members).where(eq(members.email, email)).limit(1);
    if (!member || !(await verifyPassword(password, member.passwordHash))) {
      throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
    }
    if ((member.role ?? "member") !== "staff") {
      throw new ApiError(403, "STAFF_REQUIRED", "This portal is limited to customer service staff");
    }
    return c.json(data(await issueSession(member)));
  });

  app.use("/admin/*", authenticate);
  app.use("/admin/*", requireStaff);

  app.get("/admin/overview", async (c) => {
    const [orderCounts] = await db.select({
      open: sql<number>`count(*) filter (where ${orders.status} in ('processing', 'readying_for_pickup', 'shipped'))::int`,
      delivered: sql<number>`count(*) filter (where ${orders.status} = 'delivered')::int`,
      total: sql<number>`count(*)::int`,
    }).from(orders);
    const [returnCounts] = await db.select({
      pending: sql<number>`count(*) filter (where ${returns.status} in ('requested', 'label_created', 'received', 'approved'))::int`,
      total: sql<number>`count(*)::int`,
    }).from(returns);
    const [stockCounts] = await db.select({
      low: sql<number>`count(*) filter (where ${inventory.quantity} > 0 and ${inventory.quantity} <= 8)::int`,
      out: sql<number>`count(*) filter (where ${inventory.quantity} = 0)::int`,
      units: sql<number>`coalesce(sum(${inventory.quantity}), 0)::int`,
    }).from(inventory);
    const [discountCounts] = await db.select({
      active: sql<number>`count(*) filter (where ${discounts.status} = 'active')::int`,
    }).from(discounts);
    const recent = await db.select().from(orders).orderBy(desc(orders.placedAt)).limit(5);
    return c.json(data({
      openOrders: orderCounts?.open ?? 0,
      deliveredOrders: orderCounts?.delivered ?? 0,
      orderCount: orderCounts?.total ?? 0,
      pendingReturns: returnCounts?.pending ?? 0,
      returnCount: returnCounts?.total ?? 0,
      lowStock: stockCounts?.low ?? 0,
      outOfStock: stockCounts?.out ?? 0,
      unitsOnHand: stockCounts?.units ?? 0,
      activeDiscounts: discountCounts?.active ?? 0,
      recentOrders: await Promise.all(recent.map((order) => adminOrderPayload(order))),
    }));
  });

  app.get("/admin/inventory", async (c) => {
    const warehouseId = c.req.query("warehouseId")?.trim();
    const search = c.req.query("q")?.trim();
    const lowStock = c.req.query("lowStock") === "true";
    const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
    const pageSize = Math.min(50, Math.max(1, Number.parseInt(c.req.query("pageSize") ?? "20", 10) || 20));
    const conditions = [
      warehouseId ? eq(inventory.warehouseId, warehouseId) : undefined,
      search ? or(ilike(products.name, `%${search}%`), ilike(products.sku, `%${search}%`)) : undefined,
      lowStock ? sql`${inventory.quantity} <= 8` : undefined,
    ].filter(Boolean);
    const where = conditions.length ? and(...conditions as ReturnType<typeof eq>[]) : undefined;
    const rows = await db
      .select({
        id: inventory.id,
        quantity: inventory.quantity,
        aisle: inventory.aisle,
        updatedAt: inventory.updatedAt,
        productId: products.id,
        sku: products.sku,
        name: products.name,
        warehouseId: warehouses.id,
        warehouseName: warehouses.name,
        warehouseCity: warehouses.city,
        warehouseState: warehouses.state,
      })
      .from(inventory)
      .innerJoin(products, eq(inventory.productId, products.id))
      .innerJoin(warehouses, eq(inventory.warehouseId, warehouses.id))
      .where(where)
      .orderBy(asc(warehouses.name), asc(products.name))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const countRows = await db
      .select({ id: inventory.id })
      .from(inventory)
      .innerJoin(products, eq(inventory.productId, products.id))
      .where(where);
    return c.json(data(rows.map((row) => ({
      ...row,
      lowStock: row.quantity > 0 && row.quantity <= 8,
      outOfStock: row.quantity === 0,
    })), { page, pageSize, total: countRows.length, totalPages: Math.ceil(countRows.length / pageSize) }));
  });

  app.patch("/admin/inventory/:id", async (c) => {
    const input = await body(c);
    const quantity = Number(input.quantity);
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 99_999) {
      throw new ApiError(422, "VALIDATION_ERROR", "quantity must be an integer between 0 and 99999");
    }
    const [updated] = await db.update(inventory).set({ quantity, updatedAt: new Date() }).where(eq(inventory.id, c.req.param("id"))).returning();
    if (!updated) throw new ApiError(404, "INVENTORY_NOT_FOUND", "Inventory record was not found");
    return c.json(data(updated));
  });

  app.get("/admin/orders", async (c) => {
    const status = c.req.query("status")?.trim();
    const search = c.req.query("q")?.trim();
    const conditions = [
      status ? eq(orders.status, status) : undefined,
      search
        ? or(
            ilike(orders.orderNumber, `%${search}%`),
            ilike(members.email, `%${search}%`),
            ilike(profiles.firstName, `%${search}%`),
            ilike(profiles.lastName, `%${search}%`),
          )
        : undefined,
    ].filter(Boolean);
    const rows = await db
      .select({ order: orders })
      .from(orders)
      .innerJoin(members, eq(orders.memberId, members.id))
      .leftJoin(profiles, eq(profiles.memberId, members.id))
      .where(conditions.length ? and(...conditions as ReturnType<typeof eq>[]) : undefined)
      .orderBy(desc(orders.placedAt));
    return c.json(data(await Promise.all(rows.map((row) => adminOrderPayload(row.order))), { count: rows.length }));
  });

  app.get("/admin/orders/:id", async (c) => {
    const identifier = c.req.param("id");
    const [order] = await db.select().from(orders).where(or(eq(orders.id, identifier), eq(orders.orderNumber, identifier))).limit(1);
    if (!order) throw new ApiError(404, "ORDER_NOT_FOUND", "Order was not found");
    return c.json(data(await adminOrderPayload(order, true)));
  });

  app.patch("/admin/orders/:id", async (c) => {
    const input = await body(c);
    const status = String(input.status ?? "");
    if (!orderStatuses.includes(status as typeof orderStatuses[number])) {
      throw new ApiError(422, "VALIDATION_ERROR", `status must be one of ${orderStatuses.join(", ")}`);
    }
    const [order] = await db.select().from(orders).where(eq(orders.id, c.req.param("id"))).limit(1);
    if (!order) throw new ApiError(404, "ORDER_NOT_FOUND", "Order was not found");
    const [updated] = await db.update(orders).set({
      status,
      deliveredAt: status === "delivered" ? order.deliveredAt ?? new Date() : order.deliveredAt,
      updatedAt: new Date(),
    }).where(eq(orders.id, order.id)).returning();
    return c.json(data(await adminOrderPayload(updated!, true)));
  });

  app.post("/admin/orders/:id/discounts", async (c) => {
    const input = await body(c);
    const [order] = await db.select().from(orders).where(eq(orders.id, c.req.param("id"))).limit(1);
    if (!order) throw new ApiError(404, "ORDER_NOT_FOUND", "Order was not found");
    if (order.status === "cancelled") throw new ApiError(409, "ORDER_NOT_ADJUSTABLE", "Cancelled orders cannot receive discounts");
    const reason = String(input.reason ?? "").trim();
    if (!reason) throw new ApiError(422, "VALIDATION_ERROR", "A reason is required for discretionary discounts");
    let discount = input.discountId
      ? (await db.select().from(discounts).where(eq(discounts.id, String(input.discountId))).limit(1))[0]
      : undefined;
    if (input.discountId && !discount) throw new ApiError(404, "DISCOUNT_NOT_FOUND", "Discount was not found");
    if (!discount) {
      const type = String(input.type ?? "");
      const value = Number(input.value);
      if (!["percent", "amount"].includes(type) || !Number.isFinite(value) || value <= 0) {
        throw new ApiError(422, "VALIDATION_ERROR", "type must be percent or amount and value must be greater than 0");
      }
      [discount] = await db.insert(discounts).values({
        id: randomUUID(),
        code: null,
        name: String(input.name ?? "Discretionary adjustment"),
        type,
        value: value.toFixed(2),
        reason,
        status: "active",
        createdBy: c.get("member").id,
        usedCount: 0,
        notes: "Created from an order-level customer service override",
      }).returning();
    }
    if (discount!.status !== "active") throw new ApiError(409, "DISCOUNT_INACTIVE", "This discount is not active");
    if (discount!.maxUses != null && discount!.usedCount >= discount!.maxUses) {
      throw new ApiError(409, "DISCOUNT_EXHAUSTED", "This discount has no remaining uses");
    }
    const basis = money(Number(order.subtotal) + Number(order.tax));
    const remaining = money(Math.max(0, Number(order.total)));
    const rawAmount = discount!.type === "percent" ? money(basis * (Number(discount!.value) / 100)) : money(discount!.value);
    const amount = money(Math.min(rawAmount, remaining));
    if (amount <= 0) throw new ApiError(409, "DISCOUNT_NOT_APPLICABLE", "No remaining balance to discount");
    const updated = await db.transaction(async (tx) => {
      await tx.insert(discountApplications).values({
        id: randomUUID(),
        discountId: discount!.id,
        orderId: order.id,
        amount: amount.toFixed(2),
        appliedBy: c.get("member").id,
        reason,
      });
      await tx.update(discounts).set({ usedCount: discount!.usedCount + 1, updatedAt: new Date() }).where(eq(discounts.id, discount!.id));
      const [next] = await tx.update(orders).set({
        discount: money(Number(order.discount ?? 0) + amount).toFixed(2),
        total: money(Number(order.total) - amount).toFixed(2),
        updatedAt: new Date(),
      }).where(eq(orders.id, order.id)).returning();
      return next!;
    });
    return c.json(data(await adminOrderPayload(updated, true)), 201);
  });

  app.get("/admin/returns", async (c) => {
    const status = c.req.query("status")?.trim();
    const search = c.req.query("q")?.trim();
    const conditions = [
      status ? eq(returns.status, status) : undefined,
      search ? or(ilike(returns.returnNumber, `%${search}%`), ilike(orders.orderNumber, `%${search}%`), ilike(members.email, `%${search}%`)) : undefined,
    ].filter(Boolean);
    const rows = await db
      .select({ record: returns, orderNumber: orders.orderNumber, email: members.email })
      .from(returns)
      .innerJoin(orders, eq(returns.orderId, orders.id))
      .innerJoin(members, eq(returns.memberId, members.id))
      .where(conditions.length ? and(...conditions as ReturnType<typeof eq>[]) : undefined)
      .orderBy(desc(returns.createdAt));
    return c.json(data(await Promise.all(rows.map(async ({ record, orderNumber, email }) => ({
      ...(await serializeReturn(record)),
      orderNumber,
      memberEmail: email,
    }))), { count: rows.length }));
  });

  app.patch("/admin/returns/:id", async (c) => {
    const input = await body(c);
    const status = String(input.status ?? "");
    const note = String(input.note ?? "").trim() || `Status changed to ${status}`;
    if (!returnStatuses.includes(status as typeof returnStatuses[number])) {
      throw new ApiError(422, "VALIDATION_ERROR", `status must be one of ${returnStatuses.join(", ")}`);
    }
    const [record] = await db.select().from(returns).where(eq(returns.id, c.req.param("id"))).limit(1);
    if (!record) throw new ApiError(404, "RETURN_NOT_FOUND", "Return was not found");
    const updated = await db.transaction(async (tx) => {
      const [next] = await tx.update(returns).set({ status, updatedAt: new Date() }).where(eq(returns.id, record.id)).returning();
      await tx.insert(returnHistory).values({ id: randomUUID(), returnId: record.id, status, note });
      if (status === "completed" && record.type === "return" && record.status !== "completed") {
        const items = await tx
          .select({ quantity: returnItems.quantity, productId: orderItems.productId, orderWarehouseId: orders.warehouseId })
          .from(returnItems)
          .innerJoin(orderItems, eq(returnItems.orderItemId, orderItems.id))
          .innerJoin(orders, eq(orderItems.orderId, orders.id))
          .where(eq(returnItems.returnId, record.id));
        for (const item of items) {
          const warehouseId = record.warehouseId ?? item.orderWarehouseId;
          await tx.update(inventory).set({
            quantity: sql`${inventory.quantity} + ${item.quantity}`,
            updatedAt: new Date(),
          }).where(and(eq(inventory.warehouseId, warehouseId), eq(inventory.productId, item.productId)));
        }
      }
      return next!;
    });
    return c.json(data(await serializeReturn(updated)));
  });

  app.get("/admin/discounts", async (c) => {
    const status = c.req.query("status")?.trim();
    const rows = await db.select().from(discounts).where(status ? eq(discounts.status, status) : undefined).orderBy(desc(discounts.createdAt));
    return c.json(data(rows.map((row) => ({
      ...row,
      value: money(row.value),
    })), { count: rows.length }));
  });

  app.post("/admin/discounts", async (c) => {
    const input = await body(c);
    const name = String(input.name ?? "").trim();
    const type = String(input.type ?? "");
    const value = Number(input.value);
    const reason = String(input.reason ?? "").trim();
    if (!name || !reason || !["percent", "amount"].includes(type) || !Number.isFinite(value) || value <= 0) {
      throw new ApiError(422, "VALIDATION_ERROR", "name, reason, type (percent|amount), and a positive value are required");
    }
    if (type === "percent" && value > 100) throw new ApiError(422, "VALIDATION_ERROR", "percent discounts cannot exceed 100");
    const [created] = await db.insert(discounts).values({
      id: randomUUID(),
      code: input.code ? String(input.code).trim().toUpperCase() : null,
      name,
      type,
      value: value.toFixed(2),
      reason,
      status: "active",
      createdBy: c.get("member").id,
      maxUses: input.maxUses == null || input.maxUses === "" ? null : asPositiveInt(input.maxUses, "maxUses", 10_000),
      notes: input.notes ? String(input.notes) : null,
      expiresAt: input.expiresAt ? new Date(String(input.expiresAt)) : null,
    }).returning();
    return c.json(data({ ...created, value: money(created!.value) }), 201);
  });

  app.patch("/admin/discounts/:id", async (c) => {
    const input = await body(c);
    const [existing] = await db.select().from(discounts).where(eq(discounts.id, c.req.param("id"))).limit(1);
    if (!existing) throw new ApiError(404, "DISCOUNT_NOT_FOUND", "Discount was not found");
    const status = input.status == null ? existing.status : String(input.status);
    if (!["active", "revoked", "expired"].includes(status)) {
      throw new ApiError(422, "VALIDATION_ERROR", "status must be active, revoked, or expired");
    }
    const [updated] = await db.update(discounts).set({ status, notes: input.notes == null ? existing.notes : String(input.notes), updatedAt: new Date() }).where(eq(discounts.id, existing.id)).returning();
    return c.json(data({ ...updated, value: money(updated!.value) }));
  });

  app.get("/returns/:id", authenticate, async (c) => {
    const identifier = c.req.param("id");
    const [record] = await db.select().from(returns).where(and(eq(returns.memberId, c.get("member").id), or(eq(returns.id, identifier), eq(returns.returnNumber, identifier)))).limit(1);
    if (!record) throw new ApiError(404, "RETURN_NOT_FOUND", "Return was not found");
    return c.json(data(await serializeReturn(record)));
  });

  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "Endpoint was not found" } }, 404));
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }, error.status);
    }
    console.error(error);
    return c.json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } }, 500);
  });

  return app;
}
