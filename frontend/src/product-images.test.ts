import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureKirkProductImages } from "./api";
import { ensureProductImages, productImageUrl } from "./product-images";

vi.mock("./api", () => ({
  ensureKirkProductImages: vi.fn(async (ids: string[]) => ids.map((id) => ({
    productId: id,
    url: `/api/kirk/media/product-${id}.png`,
    source: "imagine",
    cached: false,
  }))),
}));

describe("product image cache", () => {
  afterEach(() => {
    localStorage.clear();
    vi.mocked(ensureKirkProductImages).mockClear();
  });

  it("asks the API only for ids that are not cached yet", async () => {
    await ensureProductImages(["9565020", "9565020"]);
    expect(ensureKirkProductImages).toHaveBeenCalledWith(["9565020"]);
    expect(productImageUrl("9565020", "/images/product-1.svg")).toBe("/api/kirk/media/product-9565020.png");

    await ensureProductImages(["9565020", "1"]);
    expect(ensureKirkProductImages).toHaveBeenCalledWith(["1"]);
    expect(productImageUrl("1", "/fallback.svg")).toBe("/api/kirk/media/product-1.png");
  });
});
