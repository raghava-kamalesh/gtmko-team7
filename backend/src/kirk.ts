import { randomUUID } from "node:crypto";
import { desc, eq, inArray } from "drizzle-orm";
import kirkMembers from "../../shared/kirk-members.json" with { type: "json" };
import type { Database } from "./db.js";
import { preorderEmail, sendMail } from "./email.js";
import { runFeedbackLoop, searchXTrends, wiringFromEnv, type GrokBotDeps } from "./grokbot.js";
import { cartSpreadPrompt, generateImagine, heroPrompt, productCardPrompt, publicMediaUrl, type ImagineResult } from "./imagine.js";
import { ApiError } from "./http.js";
import { appendCustomerIssue, appendStockRequest } from "./issue-log.js";
import { getCatalogById } from "./storefront-catalog.js";
import {
  kirkCategoryHeroes,
  kirkFeedback,
  kirkNotifications,
  kirkOutboundMail,
  kirkPreorderItems,
  kirkPreorders,
  kirkProductImages,
  kirkPurchaseRequests,
  kirkUnmetIntents,
} from "./schema.js";

export type KirkCartLine = { productId: string; name?: string; brand?: string; imageUrl?: string; quantity: number };

type MemberSeed = {
  displayName: string;
  email?: string;
  historyCategoryIds: string[];
  unmetInterests: Array<{ text: string; category: string }>;
};

const members = kirkMembers.members as Record<string, MemberSeed>;
const categories = kirkMembers.categories;

export function resolveMember(memberKey: string): MemberSeed {
  return members[memberKey] ?? members[memberKey.toLowerCase()] ?? members.demo!;
}

/** Guest "demo" and Alex's email are the same seeded member. Staff emails stay distinct. */
export function memberKeyAliases(memberKey: string): string[] {
  const raw = memberKey.trim() || "demo";
  const lower = raw.toLowerCase();
  const aliases = new Set<string>([raw, lower]);
  const seed = members[raw] ?? members[lower];
  if (lower === "demo" || seed === members.demo) {
    aliases.add("demo");
    const email = members.demo?.email;
    if (email) {
      aliases.add(email);
      aliases.add(email.toLowerCase());
    }
  }
  if (seed?.email) {
    aliases.add(seed.email);
    aliases.add(seed.email.toLowerCase());
    for (const [key, value] of Object.entries(members)) {
      if (value === seed) aliases.add(key);
    }
  }
  return [...aliases];
}

export function historyFor(memberKey: string) {
  const profile = resolveMember(memberKey);
  const ids = profile.historyCategoryIds;
  return categories.filter((category) => ids.includes(category.id));
}

export async function getKirkHome(db: Database, memberKey: string) {
  const profile = resolveMember(memberKey);
  const history = historyFor(memberKey);
  const heroes = await db.select().from(kirkCategoryHeroes);
  const heroMap = new Map(heroes.map((row) => [row.category, row]));
  const suggestions = history.map((category) => {
    const hero = heroMap.get(category.id);
    return {
      id: category.id,
      label: category.label,
      prompt: category.prompt,
      reason: category.reason,
      heroUrl: hero?.imageUrl ?? `/images/category-1.svg`,
      heroSource: hero?.source ?? "placeholder",
    };
  });
  const preorderRows = await db.select().from(kirkPreorderItems).where(eq(kirkPreorderItems.available, true)).orderBy(desc(kirkPreorderItems.createdAt));
  const notifications = await db.select().from(kirkNotifications).where(inArray(kirkNotifications.memberKey, memberKeyAliases(memberKey))).orderBy(desc(kirkNotifications.createdAt)).limit(20);
  return {
    member: {
      key: memberKey,
      displayName: profile.displayName,
      email: profile.email ?? (memberKey.includes("@") ? memberKey : null),
      unmetInterests: profile.unmetInterests,
      history: history.map((item) => item.id),
    },
    suggestions,
    preorderItems: preorderRows,
    notifications,
    wiring: wiringFromEnv(),
  };
}

export async function regenerateHeroes(db: Database, deps: { fetch?: typeof fetch; apiKey?: string } = {}) {
  const results = [];
  for (const category of categories) {
    const generated = await generateImagine({
      kind: "category_hero",
      prompt: heroPrompt(category.label, category.reason),
    }, { fetch: deps.fetch, apiKey: deps.apiKey, persistId: `hero-${category.id}-${Date.now()}` });
    await db.insert(kirkCategoryHeroes).values({
      id: `hero-${category.id}`,
      category: category.id,
      label: category.label,
      prompt: category.prompt,
      imageUrl: generated.url,
      source: generated.source,
    }).onConflictDoUpdate({
      target: kirkCategoryHeroes.category,
      set: { imageUrl: generated.url, source: generated.source, updatedAt: new Date() },
    });
    results.push({ category: category.id, ...generated });
  }
  return results;
}

export type KirkProductImage = {
  productId: string;
  url: string;
  source: string;
  cached: boolean;
};

const productImageJobs = new Map<string, Promise<KirkProductImage>>();

function clientProductImage(url: string): string {
  return publicMediaUrl(url);
}

async function persistProductImage(
  db: Database,
  input: { productId: string; url: string; source: string; prompt: string },
) {
  await db.insert(kirkProductImages).values({
    id: `img-${input.productId}`,
    productId: input.productId,
    imageUrl: input.url,
    source: input.source,
    prompt: input.prompt,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: kirkProductImages.productId,
    set: { imageUrl: input.url, source: input.source, prompt: input.prompt, updatedAt: new Date() },
  });
}

async function generateProductImage(
  db: Database,
  productId: string,
  deps: { fetch?: typeof fetch; apiKey?: string } = {},
): Promise<KirkProductImage> {
  const product = getCatalogById(productId);
  if (!product) {
    return { productId, url: "", source: "missing", cached: false };
  }
  const prompt = productCardPrompt(product);
  const generated = await generateImagine({
    kind: "product_card",
    prompt,
  }, { fetch: deps.fetch, apiKey: deps.apiKey, persistId: `product-${productId.replace(/[^\w.-]/g, "")}` });
  const apiKey = deps.apiKey ?? process.env.XAI_API_KEY;
  if (generated.source === "imagine" || !apiKey) {
    await persistProductImage(db, {
      productId,
      url: generated.url,
      source: generated.source,
      prompt: generated.prompt,
    });
  }
  return { productId, url: clientProductImage(generated.url), source: generated.source, cached: false };
}

export async function ensureProductImages(
  db: Database,
  ids: string[],
  deps: { fetch?: typeof fetch; apiKey?: string } = {},
): Promise<KirkProductImage[]> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, 8);
  if (!unique.length) return [];
  const existing = await db.select().from(kirkProductImages).where(inArray(kirkProductImages.productId, unique));
  const have = new Map(existing.filter((row) => row.imageUrl).map((row) => [row.productId, row]));
  const missing = unique.filter((id) => {
    const row = have.get(id);
    return !row || (row.source !== "imagine" && (deps.apiKey ?? process.env.XAI_API_KEY));
  });

  const generated = await Promise.all(missing.map((id) => {
    const inflight = productImageJobs.get(id);
    if (inflight) return inflight;
    const job = generateProductImage(db, id, deps).finally(() => productImageJobs.delete(id));
    productImageJobs.set(id, job);
    return job;
  }));
  const fresh = new Map(generated.map((row) => [row.productId, row]));

  return unique.flatMap((id) => {
    const next = fresh.get(id);
    if (next?.url) return [next];
    const row = have.get(id);
    if (row?.imageUrl) {
      return [{ productId: id, url: clientProductImage(row.imageUrl), source: row.source, cached: true }];
    }
    return [];
  });
}

export async function visualizeCart(
  db: Database,
  cart: KirkCartLine[],
  deps: { fetch?: typeof fetch; apiKey?: string } = {},
): Promise<ImagineResult> {
  if (!cart.length) {
    throw new ApiError(422, "EMPTY_CART", "Add items to the cart before asking Kirk to visualize the spread");
  }
  return generateImagine({
    kind: "cart_spread",
    prompt: cartSpreadPrompt(cart),
    referenceImageUrls: cart.map((line) => line.imageUrl).filter((url): url is string => Boolean(url)).slice(0, 3),
  }, { fetch: deps.fetch, apiKey: deps.apiKey, persistId: `spread-${Date.now()}` });
}

export async function submitFeedback(
  db: Database,
  input: { memberKey: string; type: "bug" | "wish" | "interaction"; details: string; transcript: unknown },
  deps: GrokBotDeps = {},
) {
  const id = randomUUID();
  appendCustomerIssue({
    id,
    memberKey: input.memberKey,
    type: input.type,
    details: input.details,
    transcript: input.transcript,
  });
  await db.insert(kirkFeedback).values({
    id,
    memberKey: input.memberKey,
    type: input.type,
    details: input.details,
    transcript: input.transcript,
    status: "processing",
  });
  const result = await runFeedbackLoop(input, { ...deps, runTests: deps.runTests ?? (async () => ({ ok: true, summary: "queued for the cloud agent" })) });
  const [updated] = await db.update(kirkFeedback).set({
    linearIssueId: result.issue.id,
    linearIdentifier: result.issue.identifier,
    linearUrl: result.issue.url,
    agentJobId: result.agent.id,
    agentUrl: result.agent.url ?? null,
    prUrl: result.agent.prUrl ?? null,
    testResult: result.tests.summary,
    summary: `${result.issue.identifier}: ${result.tests.summary}`,
    wiring: result.wiring,
    status: "ready_for_review",
  }).where(eq(kirkFeedback.id, id)).returning();
  return updated;
}

export function looksLikeUnmetDemand(text: string): boolean {
  return /i was actually looking|nothing (fits|matches)|you don'?t have|not what i (wanted|meant)|wanted something else|can you source|unmet/i.test(text);
}

export async function captureUnmetDemand(
  db: Database,
  input: { memberKey: string; rawText: string; category?: string; attributes?: Record<string, unknown> },
  deps: GrokBotDeps = {},
) {
  const intentId = randomUUID();
  appendStockRequest({
    id: intentId,
    memberKey: input.memberKey,
    idea: input.rawText,
    category: input.category,
  });
  await db.insert(kirkUnmetIntents).values({
    id: intentId,
    memberKey: input.memberKey,
    rawText: input.rawText,
    category: input.category ?? null,
    attributes: input.attributes ?? {},
  });
  const sourced = await searchXTrends(input.rawText, deps);
  const requestId = randomUUID();
  const [request] = await db.insert(kirkPurchaseRequests).values({
    id: requestId,
    intentId,
    memberKey: input.memberKey,
    query: sourced.query,
    category: input.category ?? null,
    trends: sourced.trends,
    vendors: sourced.vendors,
    status: "pending",
  }).returning();
  return { intent: { id: intentId, ...input }, request, sourced };
}

export async function listPurchaseRequests(db: Database) {
  const rows = await db.select().from(kirkPurchaseRequests).orderBy(desc(kirkPurchaseRequests.createdAt));
  const itemRows = rows.length
    ? await db.select().from(kirkPreorderItems).where(inArray(kirkPreorderItems.purchaseRequestId, rows.map((row) => row.id)))
    : [];
  const byRequest = new Map<string, typeof itemRows>();
  for (const item of itemRows) {
    const list = byRequest.get(item.purchaseRequestId) ?? [];
    list.push(item);
    byRequest.set(item.purchaseRequestId, list);
  }
  return rows.map((row) => ({ ...row, preorderItems: byRequest.get(row.id) ?? [] }));
}

export async function decidePurchase(
  db: Database,
  input: { id: string; action: "approve" | "reject"; staffKey: string },
  deps: GrokBotDeps = {},
) {
  const [request] = await db.select().from(kirkPurchaseRequests).where(eq(kirkPurchaseRequests.id, input.id)).limit(1);
  if (!request) throw new ApiError(404, "PURCHASE_NOT_FOUND", "Purchase request was not found");
  if (request.status !== "pending") throw new ApiError(409, "ALREADY_DECIDED", "This purchase request was already decided");
  if (input.action === "reject") {
    const [updated] = await db.update(kirkPurchaseRequests).set({
      status: "rejected",
      decidedBy: input.staffKey,
      decidedAt: new Date(),
    }).where(eq(kirkPurchaseRequests.id, request.id)).returning();
    return { request: updated, preorderItem: null, mail: null };
  }

  const trend = (request.trends as Array<{ title?: string }>)[0];
  const vendor = (request.vendors as Array<{ name?: string }>)[0];
  const name = trend?.title ?? request.query;
  const [item] = await db.insert(kirkPreorderItems).values({
    id: randomUUID(),
    purchaseRequestId: request.id,
    name,
    category: request.category,
    vendor: vendor?.name ?? null,
    description: `Sourced after unmet demand: ${request.query}. Preorder opened on merch approval — no delivery wait.`,
    estimatedPrice: null,
    available: true,
  }).returning();

  const [updated] = await db.update(kirkPurchaseRequests).set({
    status: "approved",
    decidedBy: input.staffKey,
    decidedAt: new Date(),
  }).where(eq(kirkPurchaseRequests.id, request.id)).returning();

  const targets = new Set<string>([request.memberKey]);
  const seed = resolveMember(request.memberKey);
  for (const interest of seed.unmetInterests) {
    if (!request.category || interest.category === request.category) targets.add(request.memberKey);
  }
  const matchingIntents = await db.select().from(kirkUnmetIntents);
  for (const intent of matchingIntents) {
    const hay = `${intent.rawText} ${intent.category ?? ""}`.toLowerCase();
    if (hay.includes((request.category ?? "").toLowerCase()) || hay.includes(request.query.slice(0, 12).toLowerCase())) {
      targets.add(intent.memberKey);
    }
  }

  for (const memberKey of targets) {
    await db.insert(kirkNotifications).values({
      id: randomUUID(),
      memberKey,
      title: "Available to preorder",
      body: `${item!.name} is available to preorder. Merch approved the buy — no warehouse receipt wait.`,
      itemId: item!.id,
    });
  }

  const mailContent = preorderEmail({ name: item!.name, category: item!.category, vendor: item!.vendor });
  const mailResult = await sendMail(mailContent, { fetch: deps.fetch });
  await db.insert(kirkOutboundMail).values({
    id: randomUUID(),
    toAddresses: mailContent.to,
    subject: mailContent.subject,
    body: mailContent.text,
    provider: mailResult.provider,
    status: mailResult.status,
    error: mailResult.error ?? null,
  });

  return { request: updated, preorderItem: item, mail: mailResult };
}

export async function placePreorder(db: Database, input: { itemId: string; memberKey: string }) {
  const [item] = await db.select().from(kirkPreorderItems).where(eq(kirkPreorderItems.id, input.itemId)).limit(1);
  if (!item || !item.available) throw new ApiError(404, "PREORDER_NOT_OPEN", "This item is not available for preorder");
  const [created] = await db.insert(kirkPreorders).values({
    id: randomUUID(),
    itemId: item.id,
    memberKey: input.memberKey,
  }).returning();
  return { preorder: created, item };
}

export async function listNotifications(db: Database, memberKey: string) {
  return db.select().from(kirkNotifications).where(inArray(kirkNotifications.memberKey, memberKeyAliases(memberKey))).orderBy(desc(kirkNotifications.createdAt));
}

export async function markNotificationRead(db: Database, id: string, memberKey: string) {
  const [updated] = await db.update(kirkNotifications).set({ read: true }).where(eq(kirkNotifications.id, id)).returning();
  if (!updated || !memberKeyAliases(memberKey).includes(updated.memberKey)) {
    throw new ApiError(404, "NOTIFICATION_NOT_FOUND", "Notification was not found");
  }
  return updated;
}

export async function listOutboundMail(db: Database) {
  return db.select().from(kirkOutboundMail).orderBy(desc(kirkOutboundMail.createdAt));
}

export async function getFeedback(db: Database, id: string) {
  const [row] = await db.select().from(kirkFeedback).where(eq(kirkFeedback.id, id)).limit(1);
  if (!row) throw new ApiError(404, "FEEDBACK_NOT_FOUND", "Feedback was not found");
  return row;
}

export async function listFeedback(db: Database) {
  return db.select().from(kirkFeedback).orderBy(desc(kirkFeedback.createdAt));
}
