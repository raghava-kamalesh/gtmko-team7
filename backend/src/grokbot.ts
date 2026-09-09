import { spawn } from "node:child_process";
import { grokbotSummaryEmail, sendMail, type MailSendResult } from "./email.js";

export type WiringStatus = {
  linear: "live" | "mocked";
  cloudAgent: "live" | "mocked";
  xSearch: "live" | "mocked";
  email: "live" | "mocked";
};

export type LinearIssue = {
  id: string;
  identifier: string;
  url: string;
  title: string;
};

export type CloudAgentJob = {
  id: string;
  url?: string;
  prUrl?: string;
  status: string;
};

export type XSourceResult = {
  query: string;
  trends: Array<{ title: string; url?: string; note?: string }>;
  vendors: Array<{ name: string; url?: string; product?: string }>;
  source: "x_search" | "catalog_fallback";
};

export type GrokBotDeps = {
  fetch?: typeof fetch;
  linearKey?: string;
  cursorKey?: string;
  xaiKey?: string;
  runTests?: () => Promise<{ ok: boolean; summary: string }>;
  sendSummaryMail?: typeof sendMail;
};

const LINEAR_URL = "https://api.linear.app/graphql";
const CURSOR_AGENTS_URL = "https://api.cursor.com/v0/agents";
const XAI_CHAT_URL = "https://api.x.ai/v1/chat/completions";

export function wiringFromEnv(env: NodeJS.ProcessEnv = process.env): WiringStatus {
  return {
    linear: env.LINEAR_API_KEY ? "live" : "mocked",
    cloudAgent: env.CURSOR_API_KEY ? "live" : "mocked",
    xSearch: env.XAI_API_KEY ? "live" : "mocked",
    email: env.RESEND_API_KEY || env.GMAIL_ACCESS_TOKEN ? "live" : "mocked",
  };
}

export async function createLinearIssue(
  input: { title: string; description: string; teamId?: string },
  deps: GrokBotDeps = {},
): Promise<LinearIssue> {
  const key = deps.linearKey ?? process.env.LINEAR_API_KEY;
  if (!key) {
    const id = `local-${Date.now()}`;
    return {
      id,
      identifier: `KIRK-${id.slice(-4).toUpperCase()}`,
      url: `local://linear/${id}`,
      title: input.title,
    };
  }
  const teamId = input.teamId ?? process.env.LINEAR_TEAM_ID;
  const query = teamId
    ? `mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url title } } }`
    : `mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url title } } }`;
  const response = await (deps.fetch ?? fetch)(LINEAR_URL, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      variables: {
        input: {
          title: input.title,
          description: input.description,
          ...(teamId ? { teamId } : {}),
        },
      },
    }),
  });
  const payload = await response.json().catch(() => null) as {
    data?: { issueCreate?: { issue?: LinearIssue } };
    errors?: Array<{ message?: string }>;
  } | null;
  const issue = payload?.data?.issueCreate?.issue;
  if (!issue) {
    const id = `local-${Date.now()}`;
    return {
      id,
      identifier: `KIRK-${id.slice(-4).toUpperCase()}`,
      url: `local://linear/${id}`,
      title: input.title,
    };
  }
  return issue;
}

export async function launchCloudAgent(
  input: { prompt: string; repository?: string; ref?: string },
  deps: GrokBotDeps = {},
): Promise<CloudAgentJob> {
  const key = deps.cursorKey ?? process.env.CURSOR_API_KEY;
  const repository = input.repository ?? process.env.CURSOR_AGENT_REPO;
  if (!key || !repository) {
    return { id: `job-${Date.now()}`, status: "queued_local" };
  }
  const response = await (deps.fetch ?? fetch)(process.env.CURSOR_AGENTS_URL ?? CURSOR_AGENTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: { text: input.prompt },
      source: { repository, ref: input.ref ?? process.env.CURSOR_AGENT_REF ?? "main" },
    }),
  });
  const payload = await response.json().catch(() => null) as {
    id?: string;
    target?: { url?: string; prUrl?: string };
    url?: string;
  } | null;
  if (!response.ok || !payload?.id) {
    return { id: `job-${Date.now()}`, status: "launch_failed" };
  }
  return {
    id: payload.id,
    url: payload.url ?? payload.target?.url,
    prUrl: payload.target?.prUrl,
    status: "launched",
  };
}

export async function searchXTrends(
  query: string,
  deps: GrokBotDeps = {},
): Promise<XSourceResult> {
  const apiKey = deps.xaiKey ?? process.env.XAI_API_KEY;
  if (!apiKey) {
    return fallbackTrends(query);
  }
  const response = await (deps.fetch ?? fetch)(process.env.XAI_API_URL ?? XAI_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.XAI_MODEL ?? "grok-4.20-0309-non-reasoning",
      temperature: 0.2,
      max_tokens: 800,
      tools: [{ type: "x_search" }, { type: "web_search" }],
      messages: [
        {
          role: "system",
          content: "Find trending consumer products on X and vendors that sell them. Return compact JSON only: {\"trends\":[{\"title\",\"url\",\"note\"}],\"vendors\":[{\"name\",\"url\",\"product\"}]}.",
        },
        {
          role: "user",
          content: `Unmet warehouse demand: ${query}. Identify 3 trending products on X and 3 vendors.`,
        },
      ],
    }),
  });
  const payload = await response.json().catch(() => null) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  } | null;
  const text = textFromContent(payload?.choices?.[0]?.message?.content);
  const parsed = extractJson(text);
  if (parsed?.trends?.length) {
    return {
      query,
      trends: parsed.trends,
      vendors: parsed.vendors ?? [],
      source: "x_search",
    };
  }
  return fallbackTrends(query, text);
}

function fallbackTrends(query: string, note?: string): XSourceResult {
  const product = query.replace(/^i (was|am) (actually )?looking for /i, "").slice(0, 80) || query;
  return {
    query,
    trends: [
      { title: `${product} — member request spike`, note: note?.slice(0, 160) || "Fallback trend built from the unmet intent" },
      { title: `Warehouse-club pack of ${product}`, note: "High search interest in bulk size" },
    ],
    vendors: [
      { name: "Wholesale importer desk", product },
      { name: "Domestic specialty foods broker", product },
    ],
    source: "catalog_fallback",
  };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && "text" in part) return String((part as { text?: string }).text ?? "");
    return "";
  }).join("");
}

function extractJson(text: string): { trends?: XSourceResult["trends"]; vendors?: XSourceResult["vendors"] } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as { trends?: XSourceResult["trends"]; vendors?: XSourceResult["vendors"] };
  } catch {
    return null;
  }
}

export function defaultTestRunner(): Promise<{ ok: boolean; summary: string }> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["test", "-w", "backend"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, summary: "Tests timed out" });
    }, 180_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const tail = output.trim().split("\n").slice(-8).join(" | ");
      resolve({ ok: code === 0, summary: code === 0 ? `passed: ${tail}` : `failed (${code}): ${tail}` });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, summary: error.message });
    });
  });
}

export async function postHumanSummary(
  input: {
    title: string;
    ticketUrl?: string | null;
    prUrl?: string | null;
    testResult?: string | null;
    changed?: string | null;
  },
  deps: GrokBotDeps = {},
): Promise<{ mail: MailSendResult; slack?: "sent" | "skipped" }> {
  const mailer = deps.sendSummaryMail ?? sendMail;
  const mail = await mailer(grokbotSummaryEmail(input), { fetch: deps.fetch });
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return { mail, slack: "skipped" };
  const response = await (deps.fetch ?? fetch)(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: [input.title, input.ticketUrl, input.prUrl, input.testResult].filter(Boolean).join("\n"),
    }),
  });
  return { mail, slack: response.ok ? "sent" : "skipped" };
}

export async function runFeedbackLoop(
  input: {
    type: "bug" | "wish" | "interaction";
    details: string;
    transcript: unknown;
    memberKey: string;
  },
  deps: GrokBotDeps = {},
): Promise<{
  issue: LinearIssue;
  agent: CloudAgentJob;
  tests: { ok: boolean; summary: string };
  summary: { mail: MailSendResult; slack?: "sent" | "skipped" };
  wiring: WiringStatus;
}> {
  const wiring = wiringFromEnv();
  const title = `[Kirk ${input.type}] ${input.details.slice(0, 80)}`;
  const description = [
    `Type: ${input.type}`,
    `Member: ${input.memberKey}`,
    "",
    input.details,
    "",
    "Recent transcript:",
    "```json",
    JSON.stringify(input.transcript, null, 2).slice(0, 6000),
    "```",
  ].join("\n");
  const issue = await createLinearIssue({ title, description }, deps);
  const agent = await launchCloudAgent({
    prompt: [
      "Member feedback from Kirk in the Costco demo storefront.",
      `Linear: ${issue.identifier} ${issue.url}`,
      `Type: ${input.type}`,
      input.details,
      "Open a branch and PR against the assistant codebase. Add or update tests. Do not invent payment card data.",
    ].join("\n"),
  }, deps);
  const tests = deps.runTests
    ? await deps.runTests()
    : { ok: true, summary: "queued for the cloud agent" };
  const summary = await postHumanSummary({
    title,
    ticketUrl: issue.url.startsWith("http") ? issue.url : null,
    prUrl: agent.prUrl ?? agent.url,
    testResult: tests.summary,
    changed: `GrokBot opened work for Kirk ${input.type} feedback from ${input.memberKey}.`,
  }, deps);
  return { issue, agent, tests, summary, wiring };
}
