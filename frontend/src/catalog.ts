import electronics from "../../shared/catalog-electronics.json";
import furniture from "../../shared/catalog-furniture.json";
import household from "../../shared/catalog-household.json";
import type { Product, ProductSpec, Warehouse } from "./types";

type CatalogItem = {
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
  specs: ProductSpec[];
};

export function warehouseQuantity(productIndex: number, warehouseIndex: number): number {
  if ((productIndex + warehouseIndex * 5) % 17 === 0) return 0;
  return 4 + warehouseIndex * 7 + ((productIndex * 13) % 19);
}

export function catalogProducts(warehouses: Warehouse[]): Product[] {
  const items = [...electronics, ...furniture, ...household] as CatalogItem[];
  return items.map((item, index) => ({
    id: item.sku,
    name: item.name,
    category: item.category,
    price: item.compareAtPrice ?? item.price,
    memberPrice: item.price,
    compareAtPrice: item.compareAtPrice ?? undefined,
    rating: item.rating,
    reviews: item.reviewCount,
    image: `/images/product-${(index % 5) + 1}.svg`,
    badge: item.badge,
    description: item.description,
    brand: item.brand,
    sku: item.sku,
    specs: item.specs,
    featured: Boolean(item.featured),
    stockByWarehouse: Object.fromEntries(
      warehouses.map((warehouse, warehouseIndex) => [warehouse.id, warehouseQuantity(index, warehouseIndex)]),
    ),
  }));
}
