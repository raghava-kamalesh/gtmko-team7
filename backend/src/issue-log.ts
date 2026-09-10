import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type CustomerIssue = {
  id: string;
  submittedAt: string;
  memberKey: string;
  type: "bug" | "wish" | "interaction";
  details: string;
  transcript: unknown;
  notionSubmitted: boolean;
  notionPageId: string | null;
  notionSubmittedAt: string | null;
};

export function customerIssuesPath(): string {
  return process.env.KIRK_ISSUES_PATH ?? join(homedir(), "Documents", "kirk-customer-issues.json");
}

export function readCustomerIssues(filePath = customerIssuesPath()): CustomerIssue[] {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (Array.isArray(parsed)) return parsed.filter(isCustomerIssue);
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { issues?: unknown }).issues)) {
      return (parsed as { issues: unknown[] }).issues.filter(isCustomerIssue);
    }
  } catch {
    return [];
  }
  return [];
}

export function appendCustomerIssue(
  input: { memberKey: string; type: "bug" | "wish" | "interaction"; details: string; transcript: unknown; id?: string },
  filePath = customerIssuesPath(),
): CustomerIssue {
  const issues = readCustomerIssues(filePath);
  const existing = input.id ? issues.find((row) => row.id === input.id) : undefined;
  if (existing) return existing;
  const issue: CustomerIssue = {
    id: input.id ?? randomUUID(),
    submittedAt: new Date().toISOString(),
    memberKey: input.memberKey,
    type: input.type,
    details: input.details,
    transcript: input.transcript,
    notionSubmitted: false,
    notionPageId: null,
    notionSubmittedAt: null,
  };
  issues.push(issue);
  writeJsonArray(issues, filePath);
  return issue;
}

function writeJsonArray(rows: unknown[], filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rows, null, 2)}\n`);
  renameSync(tmp, filePath);
}

function isCustomerIssue(value: unknown): value is CustomerIssue {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<CustomerIssue>;
  return typeof row.id === "string" && typeof row.details === "string" && typeof row.notionSubmitted === "boolean";
}

export type StockRequest = {
  id: string;
  submittedAt: string;
  memberKey: string;
  idea: string;
  category?: string;
  notionSubmitted: boolean;
  notionPageId: string | null;
  notionSubmittedAt: string | null;
};

export function stockRequestsPath(): string {
  return process.env.KIRK_STOCK_REQUESTS_PATH ?? join(homedir(), "Documents", "kirk-stock-requests.json");
}

export function readStockRequests(filePath = stockRequestsPath()): StockRequest[] {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (Array.isArray(parsed)) return parsed.filter(isStockRequest);
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { requests?: unknown }).requests)) {
      return (parsed as { requests: unknown[] }).requests.filter(isStockRequest);
    }
  } catch {
    return [];
  }
  return [];
}

export function appendStockRequest(
  input: { memberKey: string; idea: string; category?: string; id?: string },
  filePath = stockRequestsPath(),
): StockRequest {
  const requests = readStockRequests(filePath);
  const existing = input.id ? requests.find((row) => row.id === input.id) : undefined;
  if (existing) return existing;
  const request: StockRequest = {
    id: input.id ?? randomUUID(),
    submittedAt: new Date().toISOString(),
    memberKey: input.memberKey,
    idea: input.idea,
    category: input.category,
    notionSubmitted: false,
    notionPageId: null,
    notionSubmittedAt: null,
  };
  requests.push(request);
  writeJsonArray(requests, filePath);
  return request;
}

function isStockRequest(value: unknown): value is StockRequest {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<StockRequest>;
  return typeof row.id === "string" && typeof row.idea === "string" && typeof row.notionSubmitted === "boolean";
}
