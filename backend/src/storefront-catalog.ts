import { inferDietaryTags, inferMemberOnly, inferPackSize } from "./catalog-meta.js";
import { loadCostcoCatalog, warehouseQuantity } from "./catalog-seed.js";

export type CatalogCard = {
  id: string;
  name: string;
  brand: string;
  category: string;
  memberPrice: number;
  description: string;
  stockByWarehouse: Record<string, number>;
  dietaryTags: string[];
  packSize: string | null;
  memberOnly: boolean;
};

export type CatalogMatch = CatalogCard & { inStock: boolean; quantity: number };

export type PriceConstraint = {
  minPrice?: number;
  maxPrice?: number;
};

export type CatalogSearchOptions = {
  category?: string;
  limit?: number;
  warehouseId?: string;
  minPrice?: number;
  maxPrice?: number;
};

const WAREHOUSE_IDS = ["w1", "w2", "w3", "w4"] as const;

const demoProducts: Array<{
  id: string;
  name: string;
  category: string;
  price: number;
  brand: string;
  description: string;
}> = [
  { id: "1", name: "Kirkland Signature Bath Tissue, 30 Rolls", category: "grocery", price: 23.99, brand: "Kirkland Signature", description: "Warehouse pack bath tissue selected for everyday value." },
  { id: "2", name: "Organic Mixed Berries, 3 lb", category: "grocery", price: 12.49, brand: "Organic", description: "Frozen mixed berries for smoothies and baking." },
  { id: "3", name: "MacBook Air 13-inch", category: "electronics", price: 899.99, brand: "MacBook", description: "13-inch laptop with warehouse member pricing." },
  { id: "4", name: "65-inch 4K Smart TV", category: "electronics", price: 649.99, brand: "65-inch", description: "65-inch 4K television with warehouse savings." },
  { id: "5", name: "Modular Fabric Sectional", category: "furniture", price: 1299.99, brand: "Modular", description: "Modular sectional with delivery included." },
  { id: "6", name: "Hybrid King Mattress", category: "furniture", price: 799.99, brand: "Hybrid", description: "Hybrid king mattress sold online." },
  { id: "7", name: "Men's Performance Polo 2-Pack", category: "clothing", price: 24.99, brand: "Men's", description: "Two-pack performance polos." },
  { id: "8", name: "Women's Everyday Sneaker", category: "clothing", price: 34.99, brand: "Women's", description: "Everyday sneakers in member sizes." },
  { id: "9", name: "Stainless Steel Gas Grill", category: "outdoor", price: 499.99, brand: "Stainless", description: "Member-only stainless gas grill." },
  { id: "10", name: "6-Person Instant Cabin Tent", category: "outdoor", price: 159.99, brand: "6-Person", description: "Instant cabin tent for six." },
  { id: "11", name: "Executive Gold Star Membership", category: "services", price: 130, brand: "Executive", description: "Executive membership with 2% reward." },
  { id: "12", name: "All-Season Tire Set of 4", category: "auto", price: 699.96, brand: "All-Season", description: "Set of four all-season tires with installation." },
];

let cached: CatalogCard[] | undefined;

function demoStock(id: string): Record<string, number> {
  const n = Number(id);
  return { w1: n % 3 ? 18 : 0, w2: 9, w3: n % 4 ? 6 : 0, w4: 12 };
}

function buildCatalog(): CatalogCard[] {
  const demo: CatalogCard[] = demoProducts.map((item) => ({
    id: item.id,
    name: item.name,
    brand: item.brand,
    category: item.category,
    memberPrice: Math.round(item.price * 0.92 * 100) / 100,
    description: item.description,
    stockByWarehouse: demoStock(item.id),
    dietaryTags: inferDietaryTags(item.name, item.description, item.brand),
    packSize: inferPackSize(item.name),
    memberOnly: inferMemberOnly(item.brand),
  }));
  const catalog: CatalogCard[] = loadCostcoCatalog().map((item, index) => ({
    id: item.sku,
    name: item.name,
    brand: item.brand,
    category: item.category,
    memberPrice: item.price,
    description: item.description,
    dietaryTags: inferDietaryTags(item.name, item.description, item.brand),
    packSize: inferPackSize(item.name, item.specs),
    memberOnly: inferMemberOnly(item.brand, item.badge),
    stockByWarehouse: Object.fromEntries(
      WAREHOUSE_IDS.map((warehouseId, warehouseIndex) => [warehouseId, warehouseQuantity(index, warehouseIndex)]),
    ),
  }));
  return [...demo, ...catalog];
}

export function getStorefrontCatalog(): CatalogCard[] {
  return (cached ??= buildCatalog());
}

export function getCatalogById(id: string): CatalogCard | undefined {
  return getStorefrontCatalog().find((item) => item.id === id);
}

export function withWarehouse(card: CatalogCard, warehouseId: string): CatalogMatch {
  const quantity = card.stockByWarehouse[warehouseId] ?? card.stockByWarehouse.w1 ?? 0;
  return { ...card, quantity, inStock: quantity > 0 };
}

const SEARCH_STOPWORDS = new Set([
  "do", "you", "sell", "have", "the", "for", "and", "or", "to", "my", "me", "we",
  "can", "is", "are", "was", "were", "be", "been", "actually", "looking", "something",
  "else", "please", "would", "like", "want", "need", "got", "any", "there", "this",
  "that", "what", "when", "where", "how", "with", "from", "your", "our", "they",
  "them", "their", "just", "also", "really", "about", "into", "over", "under",
  "than", "then", "too", "very", "not", "dont", "carry", "find", "source", "get",
  "show", "tell", "give", "some", "more", "than", "does",
]);
const SHORT_PRODUCT_TOKENS = new Set(["tv", "pc", "led", "gb", "lb", "4k", "hd"]);

const PRICE_AMOUNT = String.raw`\$?\s*(\d+(?:\.\d{1,2})?)`;
const BETWEEN_PRICE_RE = new RegExp(String.raw`between\s+${PRICE_AMOUNT}\s+and\s+${PRICE_AMOUNT}`, "i");
const DOLLAR_RANGE_RE = /\$\s*(\d+(?:\.\d{1,2})?)\s*(?:-|to)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i;
const MAX_PRICE_RE = new RegExp(
  String.raw`(?:only\s+)?(?:under|below|less than|cheaper than|up to|at most|no more than|max(?:imum)?(?:\s+price)?|budget(?:\s+of)?)\s+${PRICE_AMOUNT}(?:\s*(?:dollars?|usd))?`,
  "i",
);
const OR_LESS_RE = new RegExp(String.raw`${PRICE_AMOUNT}\s*(?:or less|or under|or below|and under)`, "i");
const MIN_PRICE_RE = new RegExp(
  String.raw`(?:at least|min(?:imum)?(?:\s+price)?)\s+${PRICE_AMOUNT}(?:\s*(?:dollars?|usd))?`,
  "i",
);
const MIN_PRICE_DOLLAR_RE = /(?:over|above|more than)\s+\$\s*(\d+(?:\.\d{1,2})?)(?:\s*(?:dollars?|usd))?/i;

function asMoney(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : undefined;
}

export function parsePriceConstraint(text: string): PriceConstraint {
  const normalized = text.replace(/,/g, "");
  const between = normalized.match(BETWEEN_PRICE_RE) ?? normalized.match(DOLLAR_RANGE_RE);
  if (between) {
    const first = asMoney(between[1]);
    const second = asMoney(between[2]);
    if (first != null && second != null) {
      return { minPrice: Math.min(first, second), maxPrice: Math.max(first, second) };
    }
  }
  const result: PriceConstraint = {};
  const max = normalized.match(MAX_PRICE_RE) ?? normalized.match(OR_LESS_RE);
  const min = normalized.match(MIN_PRICE_RE) ?? normalized.match(MIN_PRICE_DOLLAR_RE);
  const maxPrice = asMoney(max?.[1]);
  const minPrice = asMoney(min?.[1]);
  if (maxPrice != null) result.maxPrice = maxPrice;
  if (minPrice != null) result.minPrice = minPrice;
  return result;
}

export function mergePriceConstraints(...constraints: PriceConstraint[]): PriceConstraint {
  const result: PriceConstraint = {};
  for (const constraint of constraints) {
    if (constraint.minPrice != null && Number.isFinite(constraint.minPrice)) result.minPrice = constraint.minPrice;
    if (constraint.maxPrice != null && Number.isFinite(constraint.maxPrice)) result.maxPrice = constraint.maxPrice;
  }
  return result;
}

export function stripPricePhrases(text: string): string {
  return text
    .replace(/,/g, "")
    .replace(BETWEEN_PRICE_RE, " ")
    .replace(DOLLAR_RANGE_RE, " ")
    .replace(MAX_PRICE_RE, " ")
    .replace(OR_LESS_RE, " ")
    .replace(MIN_PRICE_RE, " ")
    .replace(MIN_PRICE_DOLLAR_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hasPriceConstraint(constraint: PriceConstraint): boolean {
  return constraint.minPrice != null || constraint.maxPrice != null;
}

export function itemFitsPrice(price: number, constraint: PriceConstraint): boolean {
  if (constraint.minPrice != null && price < constraint.minPrice) return false;
  if (constraint.maxPrice != null && price > constraint.maxPrice) return false;
  return true;
}

export function hasProductSearchTokens(text: string): boolean {
  return tokensOf(stripPricePhrases(text)).length > 0;
}

function tokensOf(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => {
    if (SEARCH_STOPWORDS.has(token)) return false;
    if (SHORT_PRODUCT_TOKENS.has(token)) return true;
    if (/^\d+$/.test(token)) return token.length >= 2;
    return token.length >= 3;
  });
}

export function searchStorefrontCatalog(
  query: string,
  options: CatalogSearchOptions = {},
): CatalogMatch[] {
  const warehouseId = options.warehouseId ?? "w1";
  const limit = Math.min(8, Math.max(1, options.limit ?? 6));
  const constraint = mergePriceConstraints(parsePriceConstraint(query), {
    minPrice: options.minPrice,
    maxPrice: options.maxPrice,
  });
  // Price words are filters, not product tokens. Leaving "400" in the query
  // matches SKUs like 4000312521 and never checks memberPrice.
  const searchQuery = stripPricePhrases(query);
  const tokens = tokensOf(searchQuery);
  if (!tokens.length) return [];
  const phrase = tokens.join(" ");
  const scored = getStorefrontCatalog()
    .filter((item) => !options.category || item.category === options.category)
    .filter((item) => itemFitsPrice(item.memberPrice, constraint))
    .map((item) => {
      const hay = `${item.id} ${item.name} ${item.brand} ${item.category} ${item.description}`.toLowerCase();
      let score = 0;
      if (item.id.toLowerCase() === query.trim().toLowerCase() || item.id.toLowerCase() === phrase) score += 80;
      if (phrase.length >= 3 && hay.includes(phrase)) score += 24;
      for (const token of tokens) {
        if (item.id.toLowerCase() === token) score += 50;
        if (item.name.toLowerCase().includes(token)) score += 8;
        if (item.brand.toLowerCase().includes(token)) score += 6;
        if (item.category.toLowerCase().includes(token)) score += 4;
        if (item.description.toLowerCase().includes(token)) score += 2;
      }
      return { item, score };
    })
    .filter((row) => row.score >= 8)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  const topScore = scored[0]?.score ?? 0;
  const cutoff = topScore >= 24 ? Math.max(8, topScore - 16) : 8;
  return scored.filter((row) => row.score >= cutoff).slice(0, limit).map((row) => withWarehouse(row.item, warehouseId));
}

export function summarizeMatch(match: CatalogMatch): Record<string, unknown> {
  return {
    id: match.id,
    name: match.name,
    brand: match.brand,
    category: match.category,
    memberPrice: match.memberPrice,
    inStock: match.inStock,
    quantity: match.quantity,
    dietaryTags: match.dietaryTags,
    packSize: match.packSize,
    memberOnly: match.memberOnly,
    description: match.description.slice(0, 180),
  };
}
