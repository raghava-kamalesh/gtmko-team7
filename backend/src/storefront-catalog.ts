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

function tokensOf(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 2);
}

export function searchStorefrontCatalog(
  query: string,
  options: { category?: string; limit?: number; warehouseId?: string } = {},
): CatalogMatch[] {
  const warehouseId = options.warehouseId ?? "w1";
  const limit = Math.min(8, Math.max(1, options.limit ?? 6));
  const tokens = tokensOf(query);
  if (!tokens.length) return [];
  const scored = getStorefrontCatalog()
    .filter((item) => !options.category || item.category === options.category)
    .map((item) => {
      const hay = `${item.id} ${item.name} ${item.brand} ${item.category} ${item.description}`.toLowerCase();
      let score = 0;
      if (item.id.toLowerCase() === query.trim().toLowerCase()) score += 80;
      if (hay.includes(query.trim().toLowerCase())) score += 24;
      for (const token of tokens) {
        if (item.id.toLowerCase() === token) score += 50;
        if (item.name.toLowerCase().includes(token)) score += 8;
        if (item.brand.toLowerCase().includes(token)) score += 6;
        if (item.category.toLowerCase().includes(token)) score += 4;
        if (item.description.toLowerCase().includes(token)) score += 2;
      }
      return { item, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  return scored.slice(0, limit).map((row) => withWarehouse(row.item, warehouseId));
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
