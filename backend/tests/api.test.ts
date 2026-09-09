import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createDatabase, type DatabaseContext } from "../src/db.js";

let context: DatabaseContext;
let app: ReturnType<typeof createApp>;

const json = async (response: Response) => response.json() as Promise<any>;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function login(email = "alex.johnson@example.com", password = "CostcoDemo123!") {
  const response = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { response, payload: await json(response) };
}

beforeAll(async () => {
  context = await createDatabase("memory://");
  app = createApp(context);
});

afterAll(async () => {
  await context.close();
});

describe("catalog and location endpoints", () => {
  it("reports health and CORS", async () => {
    const response = await app.request("/health", { headers: { Origin: "http://localhost:3000" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect((await json(response)).data.status).toBe("ok");
  });

  it("lists, searches, and gets warehouses", async () => {
    const list = await json(await app.request("/warehouses?q=Seattle&state=WA"));
    expect(list.meta.count).toBe(1);
    const detail = await app.request(`/warehouses/${list.data[0].id}`);
    expect(detail.status).toBe(200);
    expect((await json(detail)).data.inventorySummary.stockedProducts).toBeGreaterThan(0);
    expect((await app.request("/warehouses/missing")).status).toBe(404);
  });

  it("lists all categories with product counts", async () => {
    const response = await app.request("/categories");
    const payload = await json(response);
    const counts = Object.fromEntries(payload.data.map((category: any) => [category.slug, category.productCount]));
    expect(payload.data).toHaveLength(11);
    expect(counts.electronics).toBe(55);
    expect(counts.furniture).toBe(55);
    expect(counts.household).toBe(50);
    expect(counts.clothing).toBe(5);
  });

  it("filters, sorts, paginates, and resolves product availability", async () => {
    const response = await app.request("/products?search=Jones&category=clothing&sort=price_desc&page=1&pageSize=2&inStock=true&warehouseId=wh-1");
    const payload = await json(response);
    expect(response.status).toBe(200);
    expect(payload.data).toHaveLength(2);
    expect(payload.meta.total).toBe(3);
    expect(payload.data[0].price).toBeGreaterThan(payload.data[1].price);
    expect(payload.data.every((product: any) => product.inventory.inStock)).toBe(true);

    const byZip = await json(await app.request("/products?deliveryZip=10001&pageSize=1"));
    expect(byZip.meta.resolvedWarehouseId).toBe("wh-7");
  });

  it("gets product detail by id or slug", async () => {
    const response = await app.request("/products/prod-001");
    const payload = await json(response);
    expect(payload.data.media).toHaveLength(2);
    expect(payload.data.specs).toHaveLength(2);
    expect(payload.data.inventory).toHaveLength(8);
    expect((await app.request("/products/not-a-product")).status).toBe(404);
  });

  it("seeds Costco catalog products with specs and distinct warehouse stock", async () => {
    const response = await app.request("/products/prod-c-100525846");
    const payload = await json(response);
    expect(response.status).toBe(200);
    expect(payload.data.name).toMatch(/Ultra Clean HE Liquid Laundry/);
    expect(payload.data.brand).toBe("Kirkland Signature");
    expect(payload.data.specs.length).toBeGreaterThan(3);
    expect(payload.data.inventory).toHaveLength(8);
    const quantities = payload.data.inventory.map((row: { quantity: number }) => row.quantity);
    expect(new Set(quantities).size).toBeGreaterThan(1);
  });
});

describe("authentication and profile endpoints", () => {
  it("registers, reads, updates, and logs out a member", async () => {
    const registration = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "new.member@example.com",
        password: "VerySecure123!",
        firstName: "New",
        lastName: "Member",
        membershipNumber: "222000000001",
      }),
    });
    const registered = await json(registration);
    expect(registration.status).toBe(201);
    expect(registered.data.token).toBeTruthy();

    const me = await app.request("/me", { headers: auth(registered.data.token) });
    expect((await json(me)).data.profile.firstName).toBe("New");

    const updated = await app.request("/me/profile", {
      method: "PATCH",
      headers: { ...auth(registered.data.token), "Content-Type": "application/json" },
      body: JSON.stringify({ firstName: "Newest", marketingOptIn: true }),
    });
    expect((await json(updated)).data.profile).toMatchObject({ firstName: "Newest", marketingOptIn: true });

    const logout = await app.request("/auth/logout", { method: "POST", headers: auth(registered.data.token) });
    expect(logout.status).toBe(204);
    expect((await app.request("/me", { headers: auth(registered.data.token) })).status).toBe(401);
  });

  it("rejects duplicate registration, bad credentials, and missing auth", async () => {
    const duplicate = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "alex.johnson@example.com", password: "AnotherPass123!", firstName: "Alex", lastName: "J" }),
    });
    expect(duplicate.status).toBe(409);
    expect((await login("alex.johnson@example.com", "wrong-password")).response.status).toBe(401);
    expect((await app.request("/orders")).status).toBe(401);
  });
});

describe("cart merge and checkout", () => {
  it("supports guest add/update/delete and merges a guest cart on login", async () => {
    const created = await app.request("/cart/guest", { method: "POST" });
    const guest = await json(created);
    const guestId = guest.data.guestCartId;
    expect(created.status).toBe(201);

    const added = await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Guest-Cart-Id": guestId },
      body: JSON.stringify({ productId: "prod-002", quantity: 1, warehouseId: "wh-1" }),
    });
    const addedPayload = await json(added);
    expect(addedPayload.data.itemCount).toBe(1);

    const itemId = addedPayload.data.items[0].id;
    const updated = await app.request(`/cart/items/${itemId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Guest-Cart-Id": guestId },
      body: JSON.stringify({ quantity: 2 }),
    });
    expect((await json(updated)).data.itemCount).toBe(2);

    const loginResult = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "alex.johnson@example.com", password: "CostcoDemo123!", guestCartId: guestId }),
    });
    const loggedIn = await json(loginResult);
    const merged = await json(await app.request("/cart", { headers: auth(loggedIn.data.token) }));
    expect(merged.data.itemCount).toBe(2);

    const removed = await app.request(`/cart/items/${merged.data.items[0].id}`, {
      method: "DELETE",
      headers: auth(loggedIn.data.token),
    });
    expect((await json(removed)).data.itemCount).toBe(0);
  });

  it("checks out atomically, masks payment, and decrements stock", async () => {
    const { payload } = await login();
    const token = payload.data.token;
    await app.request("/cart/items", {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify({ productId: "prod-003", quantity: 2, warehouseId: "wh-1" }),
    });
    const before = await json(await app.request("/products/prod-003"));
    const beforeStock = before.data.inventory.find((entry: any) => entry.warehouseId === "wh-1").quantity;

    const rejectedPayment = await app.request("/checkout", {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        warehouseId: "wh-1",
        fulfillmentType: "warehouse_pickup",
        payment: { brand: "Visa", last4: "4242", cvc: "123", expMonth: 12, expYear: 2030 },
      }),
    });
    expect(rejectedPayment.status).toBe(422);

    const checkout = await app.request("/checkout", {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        warehouseId: "wh-1",
        fulfillmentType: "warehouse_pickup",
        payment: { brand: "Visa", last4: "4242", expMonth: 12, expYear: 2030 },
      }),
    });
    const confirmation = await json(checkout);
    expect(checkout.status).toBe(201);
    expect(confirmation.data.order.payment).toEqual({ brand: "Visa", last4: "4242", expMonth: 12, expYear: 2030 });
    expect(JSON.stringify(confirmation)).not.toContain("cvc");

    const after = await json(await app.request("/products/prod-003"));
    const afterStock = after.data.inventory.find((entry: any) => entry.warehouseId === "wh-1").quantity;
    expect(afterStock).toBe(beforeStock - 2);
    expect((await app.request("/checkout", {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify({ warehouseId: "wh-1", fulfillmentType: "warehouse_pickup", payment: { brand: "Visa", last4: "4242" } }),
    })).status).toBe(409);
  });

  it("rejects out-of-stock cart quantities", async () => {
    const { payload } = await login("jamie.chen@example.com");
    const response = await app.request("/cart/items", {
      method: "POST",
      headers: { ...auth(payload.data.token), "Content-Type": "application/json" },
      body: JSON.stringify({ productId: "prod-014", quantity: 1, warehouseId: "wh-1" }),
    });
    expect(response.status).toBe(409);
  });
});

describe("orders and returns", () => {
  it("lists and gets only the signed-in member's orders", async () => {
    const alex = (await login()).payload.data.token;
    const list = await json(await app.request("/orders", { headers: auth(alex) }));
    expect(list.data.length).toBeGreaterThanOrEqual(2);
    const detail = await app.request("/orders/order-1", { headers: auth(alex) });
    expect((await json(detail)).data.items.length).toBe(2);

    const jamie = (await login("jamie.chen@example.com")).payload.data.token;
    expect((await app.request("/orders/order-1", { headers: auth(jamie) })).status).toBe(404);
  });

  it("creates, lists, and gets a return with history", async () => {
    const token = (await login()).payload.data.token;
    const response = await app.request("/orders/order-1/returns", {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "replace",
        method: "shipping_label",
        reason: "Arrived scratched",
        items: [{ orderItemId: "oi-7", quantity: 1 }],
      }),
    });
    const created = await json(response);
    expect(response.status).toBe(201);
    expect(created.data.status).toBe("label_created");
    expect(created.data.history).toHaveLength(2);

    const list = await json(await app.request("/orders/order-1/returns", { headers: auth(token) }));
    expect(list.data.length).toBeGreaterThanOrEqual(2);
    const detail = await app.request(`/returns/${created.data.id}`, { headers: auth(token) });
    expect((await json(detail)).data.returnNumber).toBe(created.data.returnNumber);
  });

  it("enforces return ownership, state, window, quantity, and duplicate rules", async () => {
    const alex = (await login()).payload.data.token;
    const base = { type: "return", method: "warehouse", warehouseId: "wh-1", reason: "No longer needed" };
    const notDelivered = await app.request("/orders/order-2/returns", {
      method: "POST",
      headers: { ...auth(alex), "Content-Type": "application/json" },
      body: JSON.stringify({ ...base, items: [{ orderItemId: "oi-2", quantity: 1 }] }),
    });
    expect(notDelivered.status).toBe(409);

    const duplicate = await app.request("/orders/order-1/returns", {
      method: "POST",
      headers: { ...auth(alex), "Content-Type": "application/json" },
      body: JSON.stringify({ ...base, items: [{ orderItemId: "oi-1", quantity: 1 }] }),
    });
    expect(duplicate.status).toBe(409);

    const tooMany = await app.request("/orders/order-1/returns", {
      method: "POST",
      headers: { ...auth(alex), "Content-Type": "application/json" },
      body: JSON.stringify({ ...base, items: [{ orderItemId: "oi-7", quantity: 3 }] }),
    });
    expect(tooMany.status).toBe(422);

    const morgan = (await login("morgan.davis@example.com")).payload.data.token;
    const expired = await app.request("/orders/order-5/returns", {
      method: "POST",
      headers: { ...auth(morgan), "Content-Type": "application/json" },
      body: JSON.stringify({ ...base, warehouseId: "wh-3", items: [{ orderItemId: "oi-5", quantity: 1 }] }),
    });
    expect(expired.status).toBe(409);
    expect((await app.request("/returns/return-1", { headers: auth(morgan) })).status).toBe(404);
  });
});

async function staffLogin(email = "service@costco.demo") {
  const response = await app.request("/auth/staff-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "CostcoDemo123!" }),
  });
  return { response, payload: await json(response) };
}

describe("customer service operations", () => {
  it("allows staff login and rejects members", async () => {
    const staff = await staffLogin();
    expect(staff.response.status).toBe(200);
    expect(staff.payload.data.member.role).toBe("staff");
    expect((await staffLogin("alex.johnson@example.com")).response.status).toBe(403);
    const member = (await login()).payload.data.token;
    expect((await app.request("/admin/overview", { headers: auth(member) })).status).toBe(403);
    expect((await app.request("/admin/overview")).status).toBe(401);
  });

  it("lists and adjusts warehouse inventory", async () => {
    const token = (await staffLogin()).payload.data.token;
    const list = await json(await app.request("/admin/inventory?warehouseId=wh-1&pageSize=5", { headers: auth(token) }));
    expect(list.data.length).toBe(5);
    const row = list.data[0];
    const updated = await app.request(`/admin/inventory/${row.id}`, {
      method: "PATCH",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify({ quantity: row.quantity + 3 }),
    });
    expect((await json(updated)).data.quantity).toBe(row.quantity + 3);
  });

  it("updates order status and applies a discretionary discount", async () => {
    const token = (await staffLogin()).payload.data.token;
    const shipped = await app.request("/admin/orders/order-3", {
      method: "PATCH",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "shipped" }),
    });
    expect((await json(shipped)).data.status).toBe("shipped");

    const discounted = await app.request("/admin/orders/order-3/discounts", {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify({ type: "amount", value: 10, reason: "Pickup delay courtesy" }),
    });
    const payload = await json(discounted);
    expect(discounted.status).toBe(201);
    expect(payload.data.discount).toBe(10);
    expect(payload.data.total).toBe(39.27);
  });

  it("processes a return and manages discount catalog entries", async () => {
    const token = (await staffLogin()).payload.data.token;
    const updated = await app.request("/admin/returns/return-1", {
      method: "PATCH",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "received", note: "Package scanned at warehouse" }),
    });
    expect((await json(updated)).data.status).toBe("received");

    const created = await app.request("/admin/discounts", {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Aisle damage", type: "percent", value: 5, reason: "Display-case ding" }),
    });
    const discount = await json(created);
    expect(created.status).toBe(201);
    const revoked = await app.request(`/admin/discounts/${discount.data.id}`, {
      method: "PATCH",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "revoked" }),
    });
    expect((await json(revoked)).data.status).toBe("revoked");
  });
});
