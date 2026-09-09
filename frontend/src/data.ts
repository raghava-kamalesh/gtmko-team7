import { catalogProducts } from "./catalog";
import type { Product, Warehouse } from "./types";

export const warehouses: Warehouse[] = [
  { id: "w1", name: "Brooklyn", city: "Brooklyn", state: "NY", zip: "11232", address: "976 3rd Ave" },
  { id: "w2", name: "Manhattan", city: "New York", state: "NY", zip: "10035", address: "517 E 117th St" },
  { id: "w3", name: "Hackensack", city: "Hackensack", state: "NJ", zip: "07601", address: "80 S River St" },
  { id: "w4", name: "San Francisco", city: "San Francisco", state: "CA", zip: "94103", address: "450 10th St" }
];

const p = (id: string, name: string, category: string, price: number, rating: number, badge?: string): Product => ({
  id, name, category, price, memberPrice: Math.round(price * .92 * 100) / 100, rating, reviews: 82 + Number(id) * 37,
  image: `/images/product-${((Number(id) - 1) % 5) + 1}.svg`, badge, description: `Premium ${name.toLowerCase()} selected for quality, value, and everyday convenience.`,
  brand: name.startsWith("Kirkland") ? "Kirkland Signature" : name.split(" ")[0],
  sku: id.padStart(8, "0"),
  specs: [
    { name: "Item number", value: id.padStart(8, "0") },
    { name: "Brand", value: name.startsWith("Kirkland") ? "Kirkland Signature" : name.split(" ")[0] },
    { name: "Warranty", value: Number(id) % 2 ? "2 years" : "1 year" },
  ],
  stockByWarehouse: { w1: Number(id) % 3 ? 18 : 0, w2: 9, w3: Number(id) % 4 ? 6 : 0, w4: 12 }
});

const demoProducts: Product[] = [
  p("1", "Kirkland Signature Bath Tissue, 30 Rolls", "grocery", 23.99, 4.8, "Member favorite"),
  p("2", "Organic Mixed Berries, 3 lb", "grocery", 12.49, 4.6, "Organic"),
  p("3", "MacBook Air 13-inch", "electronics", 899.99, 4.9, "Warehouse savings"),
  p("4", "65-inch 4K Smart TV", "electronics", 649.99, 4.7, "$100 OFF"),
  p("5", "Modular Fabric Sectional", "furniture", 1299.99, 4.5, "Delivery included"),
  p("6", "Hybrid King Mattress", "furniture", 799.99, 4.6, "Online only"),
  p("7", "Men's Performance Polo 2-Pack", "clothing", 24.99, 4.4),
  p("8", "Women's Everyday Sneaker", "clothing", 34.99, 4.5, "New"),
  p("9", "Stainless Steel Gas Grill", "outdoor", 499.99, 4.7, "Member only item"),
  p("10", "6-Person Instant Cabin Tent", "outdoor", 159.99, 4.6, "Limited time"),
  p("11", "Executive Gold Star Membership", "services", 130, 4.9, "2% reward"),
  p("12", "All-Season Tire Set of 4", "auto", 699.96, 4.8, "Installation included")
];

export const products: Product[] = [...demoProducts, ...catalogProducts(warehouses)];

export const categories = [
  ["grocery", "Grocery"], ["household", "Household"], ["electronics", "Electronics"], ["furniture", "Furniture"],
  ["clothing", "Clothing"], ["outdoor", "Patio & Outdoor"], ["auto", "Tires & Auto"]
] as const;
