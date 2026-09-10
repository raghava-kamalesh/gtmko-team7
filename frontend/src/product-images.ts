import { useEffect, useState } from "react";
import { ensureKirkProductImages } from "./api";

const CACHE_KEY = "costco-kirk-product-images";

type ImageMap = Record<string, string>;

const listeners = new Set<() => void>();
const inflight = new Set<string>();

function readCache(): ImageMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || "") as ImageMap;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeCache(map: ImageMap) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(map));
  for (const listener of listeners) listener();
}

export function subscribeProductImages(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function productImageUrl(id: string, fallback: string): string {
  return readCache()[id] || fallback;
}

export async function ensureProductImages(ids: string[]): Promise<ImageMap> {
  const unique = [...new Set(ids.filter(Boolean))];
  const cached = readCache();
  const needed = unique.filter((id) => !cached[id] && !inflight.has(id));
  if (!needed.length) return cached;
  for (const id of needed) inflight.add(id);
  try {
    const rows = await ensureKirkProductImages(needed);
    const next = { ...readCache() };
    for (const row of rows) {
      if (row.url) next[row.productId] = row.url;
    }
    writeCache(next);
    return next;
  } catch {
    return readCache();
  } finally {
    for (const id of needed) inflight.delete(id);
  }
}

export function useProductImages() {
  const [map, setMap] = useState<ImageMap>(readCache);
  useEffect(() => subscribeProductImages(() => setMap(readCache())), []);
  return {
    urlFor: (id: string, fallback: string) => map[id] || fallback,
    ensure: (ids: string[]) => { void ensureProductImages(ids); },
  };
}
