import notify from "../../shared/kirk-members.json" with { type: "json" };

export const NOTIFY_RECIPIENTS = notify.notifyRecipients;

export type OutboundMail = {
  to: string[];
  subject: string;
  text: string;
  html?: string;
};

export type MailSendResult = {
  provider: string;
  status: "sent" | "logged";
  id?: string;
  error?: string;
};

async function sendResend(mail: OutboundMail, apiKey: string, fetchImpl: typeof fetch): Promise<MailSendResult> {
  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM ?? "Kirk <kirk@costco.demo>",
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html ?? `<pre>${mail.text}</pre>`,
    }),
  });
  const payload = await response.json().catch(() => ({})) as { id?: string; message?: string };
  if (!response.ok) {
    return { provider: "resend", status: "logged", error: payload.message ?? `HTTP ${response.status}` };
  }
  return { provider: "resend", status: "sent", id: payload.id };
}

async function sendGmail(mail: OutboundMail, token: string, fetchImpl: typeof fetch): Promise<MailSendResult> {
  const raw = [
    `To: ${mail.to.join(", ")}`,
    `Subject: ${mail.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    mail.text,
  ].join("\r\n");
  const encoded = Buffer.from(raw).toString("base64url");
  const response = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: encoded }),
  });
  const payload = await response.json().catch(() => ({})) as { id?: string; error?: { message?: string } };
  if (!response.ok) {
    return { provider: "gmail", status: "logged", error: payload.error?.message ?? `HTTP ${response.status}` };
  }
  return { provider: "gmail", status: "sent", id: payload.id };
}

export async function sendMail(
  mail: OutboundMail,
  deps: { fetch?: typeof fetch; resendKey?: string; gmailToken?: string } = {},
): Promise<MailSendResult> {
  const fetchImpl = deps.fetch ?? fetch;
  const resendKey = deps.resendKey ?? process.env.RESEND_API_KEY;
  const gmailToken = deps.gmailToken ?? process.env.GMAIL_ACCESS_TOKEN;
  try {
    if (resendKey) return await sendResend(mail, resendKey, fetchImpl);
    if (gmailToken) return await sendGmail(mail, gmailToken, fetchImpl);
  } catch (error) {
    return {
      provider: resendKey ? "resend" : "gmail",
      status: "logged",
      error: error instanceof Error ? error.message : "send failed",
    };
  }
  return { provider: "log", status: "logged" };
}

export function preorderEmail(item: { name: string; category?: string | null; vendor?: string | null }): OutboundMail {
  return {
    to: [...NOTIFY_RECIPIENTS],
    subject: `Kirk preorder open: ${item.name}`,
    text: [
      "A merch purchase was approved. Preorder is open now — no warehouse receipt wait.",
      "",
      `Item: ${item.name}`,
      item.category ? `Category: ${item.category}` : "",
      item.vendor ? `Vendor: ${item.vendor}` : "",
      "",
      "Members who logged this unmet demand can preorder in the Costco demo app.",
    ].filter(Boolean).join("\n"),
  };
}

export function grokbotSummaryEmail(input: {
  title: string;
  ticketUrl?: string | null;
  prUrl?: string | null;
  testResult?: string | null;
  changed?: string | null;
}): OutboundMail {
  return {
    to: [...NOTIFY_RECIPIENTS],
    subject: `GrokBot ready for review: ${input.title}`,
    text: [
      input.title,
      "",
      input.ticketUrl ? `Ticket: ${input.ticketUrl}` : "Ticket: (not wired)",
      input.prUrl ? `PR: ${input.prUrl}` : "PR: (agent did not return a PR)",
      input.testResult ? `Tests: ${input.testResult}` : "Tests: pending",
      input.changed ? `What changed: ${input.changed}` : "",
    ].filter(Boolean).join("\n"),
  };
}
