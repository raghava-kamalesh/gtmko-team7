import type { Context } from "hono";

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 502 | 503,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const data = <T>(value: T, meta?: Record<string, unknown>) => ({
  data: value,
  ...(meta ? { meta } : {}),
});

export async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await c.req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be a JSON object");
  }
}

export function memberKeyFrom(input: { email?: string | null; id?: string | null } | null | undefined): string {
  const email = input?.email?.trim().toLowerCase();
  if (email) return email;
  return "demo";
}
