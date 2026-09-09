import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import type { DatabaseContext } from "./db.js";
import { ApiError, data, memberKeyFrom, readJsonBody } from "./http.js";
import {
  captureUnmetDemand,
  decidePurchase,
  getFeedback,
  getKirkHome,
  listFeedback,
  listNotifications,
  listOutboundMail,
  listPurchaseRequests,
  markNotificationRead,
  placePreorder,
  regenerateHeroes,
  submitFeedback,
  visualizeCart,
  type KirkCartLine,
} from "./kirk.js";
import { wiringFromEnv } from "./grokbot.js";
import { createVoiceSession } from "./voice.js";

type Member = { id: string; email: string; role?: string | null };

export function registerKirkRoutes(
  app: Hono<{ Variables: { member: Member } }>,
  context: DatabaseContext,
  auth: {
    optionalMember: (c: { req: { header: (name: string) => string | undefined } }) => Promise<Member | null>;
  },
) {
  const { db } = context;

  const keyFrom = async (c: { req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined } }, body?: Record<string, unknown>) => {
    const member = await auth.optionalMember(c).catch(() => null);
    return memberKeyFrom({
      email: member?.email ?? (typeof body?.memberKey === "string" ? body.memberKey : c.req.query("memberKey")),
    });
  };

  app.get("/kirk/home", async (c) => {
    const memberKey = await keyFrom(c);
    return c.json(data(await getKirkHome(db, memberKey)));
  });

  app.get("/kirk/notifications", async (c) => {
    const memberKey = await keyFrom(c);
    return c.json(data(await listNotifications(db, memberKey)));
  });

  app.post("/kirk/notifications/:id/read", async (c) => {
    const memberKey = await keyFrom(c);
    return c.json(data(await markNotificationRead(db, c.req.param("id"), memberKey)));
  });

  app.post("/kirk/feedback", async (c) => {
    const input = await readJsonBody(c);
    const type = String(input.type ?? "");
    const details = String(input.details ?? "").trim();
    if (!["bug", "wish", "interaction"].includes(type) || details.length < 3) {
      throw new ApiError(422, "VALIDATION_ERROR", "type must be bug, wish, or interaction and details are required");
    }
    const memberKey = await keyFrom(c, input);
    const created = await submitFeedback(db, {
      memberKey,
      type: type as "bug" | "wish" | "interaction",
      details,
      transcript: input.transcript ?? [],
    });
    return c.json(data(created), 201);
  });

  app.get("/kirk/feedback/:id", async (c) => c.json(data(await getFeedback(db, c.req.param("id")))));

  app.post("/kirk/demand", async (c) => {
    const input = await readJsonBody(c);
    const rawText = String(input.rawText ?? input.text ?? "").trim();
    if (rawText.length < 3) throw new ApiError(422, "VALIDATION_ERROR", "rawText is required");
    const memberKey = await keyFrom(c, input);
    return c.json(data(await captureUnmetDemand(db, {
      memberKey,
      rawText,
      category: typeof input.category === "string" ? input.category : undefined,
      attributes: input.attributes && typeof input.attributes === "object" ? input.attributes as Record<string, unknown> : undefined,
    })), 201);
  });

  app.get("/kirk/preorders", async (c) => {
    const home = await getKirkHome(db, await keyFrom(c));
    return c.json(data(home.preorderItems));
  });

  app.post("/kirk/preorders", async (c) => {
    const input = await readJsonBody(c);
    const itemId = String(input.itemId ?? "");
    if (!itemId) throw new ApiError(422, "VALIDATION_ERROR", "itemId is required");
    return c.json(data(await placePreorder(db, { itemId, memberKey: await keyFrom(c, input) })), 201);
  });

  app.post("/assistant/imagine", async (c) => {
    const input = await readJsonBody(c);
    const kind = String(input.kind ?? "cart_spread");
    if (kind === "category_hero") {
      return c.json(data({ heroes: await regenerateHeroes(db) }));
    }
    const cart = Array.isArray(input.cart) ? input.cart as KirkCartLine[] : [];
    return c.json(data(await visualizeCart(db, cart)));
  });

  app.post("/kirk/heroes/regenerate", async (c) => c.json(data({ heroes: await regenerateHeroes(db) })));

  app.post("/assistant/voice/session", async (c) => {
    const input = await readJsonBody(c).catch(() => ({}) as Record<string, unknown>);
    const warehouse = input.warehouse && typeof input.warehouse === "object" && !Array.isArray(input.warehouse)
      ? input.warehouse as { id?: string; name?: string }
      : {};
    return c.json(data(createVoiceSession({
      warehouse: { id: String(warehouse.id ?? "w1"), name: String(warehouse.name ?? "Warehouse") },
      cartSummary: typeof input.cartSummary === "string" ? input.cartSummary : undefined,
      conversationId: typeof input.conversationId === "string" ? input.conversationId : undefined,
    })));
  });

  app.get("/kirk/media/:file", async (c) => {
    const file = c.req.param("file");
    if (!/^[\w.-]+$/.test(file)) throw new ApiError(404, "NOT_FOUND", "Media was not found");
    const dir = process.env.KIRK_MEDIA_DIR ?? join(fileURLToPath(new URL(".", import.meta.url)), "../data/imagine");
    try {
      const bytes = await readFile(join(dir, file));
      const type = file.endsWith(".jpg") || file.endsWith(".jpeg") ? "image/jpeg" : file.endsWith(".svg") ? "image/svg+xml" : "image/png";
      return c.body(bytes, 200, { "Content-Type": type, "Cache-Control": "public, max-age=86400" });
    } catch {
      throw new ApiError(404, "NOT_FOUND", "Media was not found");
    }
  });

  app.get("/admin/kirk/purchases", async (c) => c.json(data(await listPurchaseRequests(db), { wiring: wiringFromEnv() })));
  app.get("/admin/kirk/feedback", async (c) => c.json(data(await listFeedback(db), { wiring: wiringFromEnv() })));
  app.get("/admin/kirk/mail", async (c) => c.json(data(await listOutboundMail(db), { wiring: wiringFromEnv() })));
  app.post("/admin/kirk/purchases/:id/decide", async (c) => {
    const input = await readJsonBody(c);
    const action = String(input.action ?? "");
    if (action !== "approve" && action !== "reject") {
      throw new ApiError(422, "VALIDATION_ERROR", "action must be approve or reject");
    }
    const member = c.get("member");
    return c.json(data(await decidePurchase(db, {
      id: c.req.param("id"),
      action,
      staffKey: member?.email ?? "staff",
    })));
  });
}
