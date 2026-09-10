import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendCustomerIssue, appendStockRequest, readCustomerIssues, readStockRequests } from "../src/issue-log.js";

describe("customer issue log", () => {
  it("appends an issue tagged as not yet sent to Notion", () => {
    const filePath = join(mkdtempSync(join(tmpdir(), "kirk-issues-")), "kirk-customer-issues.json");
    const first = appendCustomerIssue({
      memberKey: "alex.johnson@example.com",
      type: "bug",
      details: "Voice cut me off mid sentence",
      transcript: [{ role: "user", text: "I need a TV" }],
    }, filePath);
    expect(first.notionSubmitted).toBe(false);
    expect(first.notionPageId).toBeNull();
    expect(first.id).toMatch(/-/);

    const second = appendCustomerIssue({
      memberKey: "demo",
      type: "bug",
      details: "Showed the wrong product card",
      transcript: [],
    }, filePath);
    const stored = readCustomerIssues(filePath);
    expect(stored).toHaveLength(2);
    expect(stored.map((row) => row.id)).toEqual([first.id, second.id]);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toHaveLength(2);
  });

  it("does not append the same id twice", () => {
    const filePath = join(mkdtempSync(join(tmpdir(), "kirk-issues-")), "kirk-customer-issues.json");
    const first = appendCustomerIssue({
      id: "issue-1",
      memberKey: "demo",
      type: "bug",
      details: "Duplicate submit",
      transcript: [],
    }, filePath);
    const again = appendCustomerIssue({
      id: "issue-1",
      memberKey: "demo",
      type: "bug",
      details: "Duplicate submit",
      transcript: [],
    }, filePath);
    expect(again).toEqual(first);
    expect(readCustomerIssues(filePath)).toHaveLength(1);
  });
});

describe("stock request log", () => {
  it("appends an idea tagged as not yet sent to Notion", () => {
    const filePath = join(mkdtempSync(join(tmpdir(), "kirk-stock-")), "kirk-stock-requests.json");
    const first = appendStockRequest({
      memberKey: "alex.johnson@example.com",
      idea: "12-year Yamazaki gift box",
      category: "grocery",
    }, filePath);
    expect(first.notionSubmitted).toBe(false);
    expect(first.notionPageId).toBeNull();
    expect(first.idea).toBe("12-year Yamazaki gift box");

    const second = appendStockRequest({
      memberKey: "demo",
      idea: "fragrance-free baby wipes",
    }, filePath);
    const stored = readStockRequests(filePath);
    expect(stored).toHaveLength(2);
    expect(stored.map((row) => row.id)).toEqual([first.id, second.id]);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toHaveLength(2);
  });

  it("does not append the same id twice", () => {
    const filePath = join(mkdtempSync(join(tmpdir(), "kirk-stock-")), "kirk-stock-requests.json");
    const first = appendStockRequest({
      id: "stock-1",
      memberKey: "demo",
      idea: "Japanese whisky gift set",
    }, filePath);
    const again = appendStockRequest({
      id: "stock-1",
      memberKey: "demo",
      idea: "Japanese whisky gift set",
    }, filePath);
    expect(again).toEqual(first);
    expect(readStockRequests(filePath)).toHaveLength(1);
  });
});
