import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "./schema.js";

export type CatalogProduct = {
  sku: string;
  category: "electronics" | "furniture" | "household";
  name: string;
  brand: string;
  description: string;
  price: number;
  compareAtPrice: number | null;
  rating: number;
  reviewCount: number;
  featured?: boolean;
  badge?: string;
  specs: { name: string; value: string }[];
};

type Database = PgliteDatabase<typeof schema>;

const categoryIds = {
  electronics: "cat-2",
  furniture: "cat-4",
  household: "cat-11",
} as const;

export function warehouseQuantity(productIndex: number, warehouseIndex: number): number {
  if ((productIndex + warehouseIndex * 5) % 17 === 0) return 0;
  return 4 + warehouseIndex * 7 + ((productIndex * 13) % 19);
}

export function loadCostcoCatalog(): CatalogProduct[] {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../shared");
  return (["electronics", "furniture", "household"] as const).flatMap((name) =>
    JSON.parse(readFileSync(join(dir, `catalog-${name}.json`), "utf8")) as CatalogProduct[],
  );
}

function slugFor(name: string, sku: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${base}-${sku}`.slice(0, 96);
}

export async function seedCostcoCatalog(db: Database): Promise<void> {
  const [household] = await db.select({ id: schema.categories.id }).from(schema.categories).where(eq(schema.categories.slug, "household")).limit(1);
  if (!household) {
    await db.insert(schema.categories).values({
      id: categoryIds.household,
      slug: "household",
      name: "Household",
      description: "Paper goods, laundry, cleaning, and everyday warehouse essentials",
    });
  }

  const catalog = loadCostcoCatalog();
  const existing = await db.select({ sku: schema.products.sku }).from(schema.products);
  const have = new Set(existing.map((row) => row.sku));
  const incoming = catalog.filter((item) => !have.has(item.sku));
  if (incoming.length === 0) return;

  const warehouses = await db.select({ id: schema.warehouses.id }).from(schema.warehouses);
  const productsRows = incoming.map((item) => ({
    id: `prod-c-${item.sku}`,
    sku: item.sku,
    categoryId: categoryIds[item.category],
    slug: slugFor(item.name, item.sku),
    name: item.name,
    brand: item.brand,
    description: item.description,
    price: item.price.toFixed(2),
    compareAtPrice: item.compareAtPrice != null ? item.compareAtPrice.toFixed(2) : null,
    rating: item.rating.toFixed(1),
    reviewCount: item.reviewCount,
    featured: Boolean(item.featured),
  }));

  await db.insert(schema.products).values(productsRows);

  await db.insert(schema.productMedia).values(incoming.flatMap((item, index) => [
    {
      id: `media-c-${item.sku}-1`,
      productId: `prod-c-${item.sku}`,
      url: `/images/product-${(index % 5) + 1}.svg`,
      alt: item.name,
      position: 0,
    },
    {
      id: `media-c-${item.sku}-2`,
      productId: `prod-c-${item.sku}`,
      url: `/images/product-${((index + 1) % 5) + 1}.svg`,
      alt: `${item.name} detail`,
      position: 1,
    },
  ]));

  await db.insert(schema.productSpecs).values(incoming.flatMap((item) =>
    item.specs.map((spec, position) => ({
      id: `spec-c-${item.sku}-${position}`,
      productId: `prod-c-${item.sku}`,
      name: spec.name,
      value: spec.value,
      position,
    })),
  ));

  await db.insert(schema.inventory).values(incoming.flatMap((item, productIndex) =>
    warehouses.map((warehouse, warehouseIndex) => ({
      id: `inv-c-${warehouseIndex + 1}-${item.sku}`,
      warehouseId: warehouse.id,
      productId: `prod-c-${item.sku}`,
      quantity: warehouseQuantity(productIndex, warehouseIndex),
      aisle: `${String.fromCharCode(65 + (productIndex % 12))}${1 + (warehouseIndex % 24)}`,
    })),
  ));
}
