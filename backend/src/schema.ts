import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const categories = pgTable("categories", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  imageUrl: text("image_url"),
  ...timestamps,
});

export const products = pgTable("products", {
  id: text("id").primaryKey(),
  sku: text("sku").notNull().unique(),
  categoryId: text("category_id").notNull().references(() => categories.id),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  brand: text("brand").notNull(),
  description: text("description").notNull(),
  price: numeric("price", { precision: 12, scale: 2 }).notNull(),
  compareAtPrice: numeric("compare_at_price", { precision: 12, scale: 2 }),
  rating: numeric("rating", { precision: 2, scale: 1 }).notNull(),
  reviewCount: integer("review_count").notNull().default(0),
  featured: boolean("featured").notNull().default(false),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

export const productMedia = pgTable("product_media", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  alt: text("alt").notNull(),
  position: integer("position").notNull().default(0),
});

export const productSpecs = pgTable("product_specs", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  value: text("value").notNull(),
  position: integer("position").notNull().default(0),
});

export const warehouses = pgTable("warehouses", {
  id: text("id").primaryKey(),
  number: text("number").notNull().unique(),
  name: text("name").notNull(),
  address1: text("address1").notNull(),
  city: text("city").notNull(),
  state: text("state").notNull(),
  zip: text("zip").notNull(),
  phone: text("phone").notNull(),
  latitude: numeric("latitude", { precision: 9, scale: 6 }).notNull(),
  longitude: numeric("longitude", { precision: 9, scale: 6 }).notNull(),
  hours: jsonb("hours").notNull(),
  services: jsonb("services").notNull(),
  ...timestamps,
});

export const inventory = pgTable(
  "inventory",
  {
    id: text("id").primaryKey(),
    warehouseId: text("warehouse_id").notNull().references(() => warehouses.id),
    productId: text("product_id").notNull().references(() => products.id),
    quantity: integer("quantity").notNull().default(0),
    aisle: text("aisle"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("inventory_warehouse_product").on(table.warehouseId, table.productId)],
);

export const members = pgTable("members", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("member"),
  membershipNumber: text("membership_number").unique(),
  membershipTier: text("membership_tier").notNull().default("gold_star"),
  membershipExpiresAt: timestamp("membership_expires_at", { withTimezone: true }),
  ...timestamps,
});

export const profiles = pgTable("profiles", {
  memberId: text("member_id").primaryKey().references(() => members.id, { onDelete: "cascade" }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  phone: text("phone"),
  marketingOptIn: boolean("marketing_opt_in").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const addresses = pgTable("addresses", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  address1: text("address1").notNull(),
  address2: text("address2"),
  city: text("city").notNull(),
  state: text("state").notNull(),
  zip: text("zip").notNull(),
  phone: text("phone"),
  isDefault: boolean("is_default").notNull().default(false),
  ...timestamps,
});

export const carts = pgTable("carts", {
  id: text("id").primaryKey(),
  memberId: text("member_id").references(() => members.id, { onDelete: "cascade" }),
  guestToken: text("guest_token").unique(),
  warehouseId: text("warehouse_id").references(() => warehouses.id),
  status: text("status").notNull().default("active"),
  ...timestamps,
});

export const cartItems = pgTable(
  "cart_items",
  {
    id: text("id").primaryKey(),
    cartId: text("cart_id").notNull().references(() => carts.id, { onDelete: "cascade" }),
    productId: text("product_id").notNull().references(() => products.id),
    quantity: integer("quantity").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("cart_product").on(table.cartId, table.productId)],
);

export const orders = pgTable("orders", {
  id: text("id").primaryKey(),
  orderNumber: text("order_number").notNull().unique(),
  memberId: text("member_id").notNull().references(() => members.id),
  warehouseId: text("warehouse_id").notNull().references(() => warehouses.id),
  status: text("status").notNull(),
  fulfillmentType: text("fulfillment_type").notNull(),
  subtotal: numeric("subtotal", { precision: 12, scale: 2 }).notNull(),
  tax: numeric("tax", { precision: 12, scale: 2 }).notNull(),
  discount: numeric("discount", { precision: 12, scale: 2 }).notNull().default("0"),
  total: numeric("total", { precision: 12, scale: 2 }).notNull(),
  shippingAddress: jsonb("shipping_address"),
  payment: jsonb("payment").notNull(),
  placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  ...timestamps,
});

export const orderItems = pgTable("order_items", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  productId: text("product_id").notNull().references(() => products.id),
  sku: text("sku").notNull(),
  name: text("name").notNull(),
  unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull(),
  quantity: integer("quantity").notNull(),
  imageUrl: text("image_url"),
});

export const shipments = pgTable("shipments", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  carrier: text("carrier"),
  trackingNumber: text("tracking_number"),
  status: text("status").notNull(),
  shippedAt: timestamp("shipped_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const returns = pgTable("returns", {
  id: text("id").primaryKey(),
  returnNumber: text("return_number").notNull().unique(),
  orderId: text("order_id").notNull().references(() => orders.id),
  memberId: text("member_id").notNull().references(() => members.id),
  type: text("type").notNull(),
  method: text("method").notNull(),
  warehouseId: text("warehouse_id").references(() => warehouses.id),
  reason: text("reason").notNull(),
  status: text("status").notNull(),
  labelUrl: text("label_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const returnItems = pgTable("return_items", {
  id: text("id").primaryKey(),
  returnId: text("return_id").notNull().references(() => returns.id, { onDelete: "cascade" }),
  orderItemId: text("order_item_id").notNull().references(() => orderItems.id),
  quantity: integer("quantity").notNull(),
  resolution: text("resolution").notNull(),
});

export const returnHistory = pgTable("return_history", {
  id: text("id").primaryKey(),
  returnId: text("return_id").notNull().references(() => returns.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const discounts = pgTable("discounts", {
  id: text("id").primaryKey(),
  code: text("code").unique(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  value: numeric("value", { precision: 12, scale: 2 }).notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("active"),
  createdBy: text("created_by").references(() => members.id),
  maxUses: integer("max_uses"),
  usedCount: integer("used_count").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  notes: text("notes"),
  ...timestamps,
});

export const discountApplications = pgTable("discount_applications", {
  id: text("id").primaryKey(),
  discountId: text("discount_id").notNull().references(() => discounts.id),
  orderId: text("order_id").notNull().references(() => orders.id),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  appliedBy: text("applied_by").notNull().references(() => members.id),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Member = typeof members.$inferSelect;
