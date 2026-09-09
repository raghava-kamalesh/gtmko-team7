export function inferDietaryTags(name: string, description = "", brand = ""): string[] {
  const hay = `${name} ${description} ${brand}`.toLowerCase();
  const tags: string[] = [];
  if (/\borganic\b/.test(hay)) tags.push("organic");
  if (/\bgluten[- ]free\b/.test(hay)) tags.push("gluten-free");
  if (/\bvegan\b/.test(hay)) tags.push("vegan");
  if (/\bvegetarian\b/.test(hay)) tags.push("vegetarian");
  if (/\bkosher\b/.test(hay)) tags.push("kosher");
  if (/\bketo\b/.test(hay)) tags.push("keto");
  if (/\bsugar[- ]free\b/.test(hay)) tags.push("sugar-free");
  if (/\bnut[- ]free\b/.test(hay)) tags.push("nut-free");
  return [...new Set(tags)];
}

export function inferPackSize(name: string, specs: Array<{ name: string; value: string }> = []): string | null {
  const quantity = specs.find((spec) => /quantity|pack|count|size/i.test(spec.name));
  if (quantity?.value) return quantity.value;
  const match = name.match(/(\d+\s*(?:ct|count|pk|pack|rolls?|lb|oz|fl oz|sheets?|piece|pc)\b[^,]*)/i);
  return match?.[1]?.trim() ?? null;
}

export function inferMemberOnly(brand: string, badge?: string): boolean {
  return /kirkland/i.test(brand) || /member only/i.test(badge ?? "");
}
