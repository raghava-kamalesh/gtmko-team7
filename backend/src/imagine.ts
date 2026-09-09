import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError } from "./http.js";

const XAI_IMAGES_URL = "https://api.x.ai/v1/images/generations";
const DEFAULT_MODEL = "grok-imagine-image";

export type ImagineKind = "category_hero" | "cart_spread";

export type ImagineInput = {
  kind: ImagineKind;
  prompt: string;
  referenceImageUrls?: string[];
};

export type ImagineResult = {
  url: string;
  b64?: string;
  model: string;
  source: "imagine" | "placeholder";
  prompt: string;
};

function mediaDir(): string {
  return process.env.KIRK_MEDIA_DIR
    ?? join(dirname(fileURLToPath(import.meta.url)), "../data/imagine");
}

function placeholderResult(input: ImagineInput, model: string): ImagineResult {
  return {
    url: placeholderSvg(input.kind === "cart_spread" ? "Cart spread" : "Category hero", input.prompt.slice(0, 80)),
    model,
    source: "placeholder",
    prompt: input.prompt,
  };
}

export function placeholderSvg(title: string, detail: string): string {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <rect width="960" height="540" fill="#e8f3fa"/>
  <rect x="48" y="48" width="864" height="444" rx="24" fill="#fff" stroke="#005daa" stroke-width="4"/>
  <text x="80" y="180" fill="#e31837" font-family="Arial" font-size="22" font-weight="700">KIRK · IMAGINE</text>
  <text x="80" y="260" fill="#003b70" font-family="Arial" font-size="42" font-weight="700">${escapeXml(title)}</text>
  <text x="80" y="320" fill="#5c6370" font-family="Arial" font-size="22">${escapeXml(detail)}</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (ch) => (
    { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;" }[ch] ?? ch
  ));
}

export function heroPrompt(label: string, reason: string): string {
  return [
    `Photorealistic warehouse-club category hero photograph of ${label}.`,
    "Bright retail aisle lighting, bulk member packs on pallets, clean commercial photography.",
    "No readable trademarks, no Costco logo, no text overlays.",
    reason ? `Member context: ${reason}.` : "",
    "Look like a warehouse wholesale club, not a boutique grocery.",
  ].filter(Boolean).join(" ");
}

export function cartSpreadPrompt(items: Array<{ name?: string; brand?: string; quantity?: number }>): string {
  const list = items.length
    ? items.map((item) => `${item.quantity ?? 1}× ${item.brand ? `${item.brand} ` : ""}${item.name}`).join("; ")
    : "an empty serving table waiting for warehouse staples";
  return [
    "Photorealistic overhead party table / kitchen island spread for a warehouse-club member.",
    `Ground the scene in these exact cart SKUs: ${list}.`,
    "Bulk pack sizes visible, warm home lighting, plates and serving bowls, no logos or watermarks.",
  ].join(" ");
}

async function persistImage(id: string, bytes: Buffer, ext: string): Promise<string> {
  const dir = mediaDir();
  await mkdir(dir, { recursive: true });
  const file = `${id}.${ext}`;
  await writeFile(join(dir, file), bytes);
  return `/kirk/media/${file}`;
}

function decodeDataUrl(url: string): { mime: string; bytes: Buffer } | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match?.[1] || !match[2]) return null;
  return { mime: match[1], bytes: Buffer.from(match[2], "base64") };
}

export async function generateImagine(
  input: ImagineInput,
  deps: { fetch?: typeof fetch; apiKey?: string; model?: string; persistId?: string } = {},
): Promise<ImagineResult> {
  const apiKey = deps.apiKey ?? process.env.XAI_API_KEY;
  const model = deps.model ?? process.env.XAI_IMAGINE_MODEL ?? DEFAULT_MODEL;
  const persistId = deps.persistId ?? `img-${Date.now()}`;
  if (!apiKey) {
    return placeholderResult(input, model);
  }

  const body: Record<string, unknown> = {
    model,
    prompt: input.prompt,
    n: 1,
    aspect_ratio: input.kind === "category_hero" ? "16:9" : "4:3",
    response_format: "b64_json",
  };
  if (input.referenceImageUrls?.length) {
    body.image = input.referenceImageUrls[0];
    body.images = input.referenceImageUrls.slice(0, 3);
  }

  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(process.env.XAI_IMAGES_URL ?? XAI_IMAGES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    return placeholderResult(input, model);
  }
  const payload = await response.json().catch(() => null) as {
    data?: Array<{ url?: string; b64_json?: string }>;
    error?: { message?: string };
  } | null;
  if (!response.ok) {
    return placeholderResult(input, model);
  }
  const first = payload?.data?.[0];
  if (first?.b64_json) {
    const bytes = Buffer.from(first.b64_json, "base64");
    const url = await persistImage(persistId, bytes, "png");
    return { url, b64: first.b64_json, model, source: "imagine", prompt: input.prompt };
  }
  if (first?.url) {
    if (first.url.startsWith("data:")) {
      const decoded = decodeDataUrl(first.url);
      if (decoded) {
        const ext = decoded.mime.includes("jpeg") ? "jpg" : "png";
        const url = await persistImage(persistId, decoded.bytes, ext);
        return { url, model, source: "imagine", prompt: input.prompt };
      }
    }
    return { url: first.url, model, source: "imagine", prompt: input.prompt };
  }
  throw new ApiError(502, "IMAGINE_ERROR", "Imagine returned an empty image");
}
