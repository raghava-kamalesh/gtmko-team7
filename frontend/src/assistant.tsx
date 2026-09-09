import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { sendAssistantChat } from "./api";
import { useStore } from "./store";
import type { Product } from "./types";

type AssistantApi = { openAssistant: (prompt?: string) => void };
const AssistantContext = createContext<AssistantApi>({ openAssistant: () => {} });
export const useAssistant = () => useContext(AssistantContext);

export type ChatLine = {
  id: string;
  role: "user" | "assistant";
  text: string;
  productIds?: string[];
  awaitingView?: boolean;
};

const CHAT_KEY = "costco-assistant-chat";

const readLines = (): ChatLine[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_KEY) || "") as ChatLine[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `line-${Date.now()}-${Math.random()}`);

export function isAffirmative(text: string) {
  return /^(y|yes|yeah|yep|yup|sure|ok|okay|please|show me|open it|go ahead|do it)\b/i.test(text.trim());
}

export function isNegative(text: string) {
  return /^(n|no|nope|nah|not now|later|skip)\b/i.test(text.trim());
}

export function replyAsksToView(reply: string) {
  return /would you like to see|want to (see|open|view)|shall i (open|show)|product page/i.test(reply);
}

function viewQuestion(product: Product) {
  return `Would you like to see the product page for ${product.name}?`;
}

export const HeadsetIcon = ({ size = 26 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M5 13a7 7 0 0 1 14 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <rect x="3.2" y="12.1" width="3.2" height="5.3" rx="1.5" fill="currentColor" />
    <rect x="17.6" y="12.1" width="3.2" height="5.3" rx="1.5" fill="currentColor" />
    <circle cx="12" cy="10.1" r="2.75" fill="currentColor" />
    <path d="M7.1 20.6c.75-2.15 2.45-3.25 4.9-3.25s4.15 1.1 4.9 3.25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M6.1 17.15c.15 1.9 2.35 3.15 5.4 3.15" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
    <circle cx="6.1" cy="17.15" r="1.2" fill="currentColor" />
  </svg>
);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<{ id: string; text: string } | undefined>();
  const openAssistant = (prompt?: string) => {
    setPending(prompt ? { id: newId(), text: prompt } : undefined);
    setOpen(true);
  };
  return (
    <AssistantContext.Provider value={{ openAssistant }}>
      {children}
      <AssistantWidget
        open={open}
        pending={pending}
        onConsumed={() => setPending(undefined)}
        onClose={() => setOpen(false)}
        onOpen={() => setOpen(true)}
      />
    </AssistantContext.Provider>
  );
}

function AssistantWidget({ open, pending, onConsumed, onClose, onOpen }: {
  open: boolean; pending?: { id: string; text: string }; onConsumed: () => void; onClose: () => void; onOpen: () => void;
}) {
  const { products, warehouse } = useStore();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<ChatLine[]>(readLines);
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const linesRef = useRef(lines);
  const handledPending = useRef<string | null>(null);
  linesRef.current = lines;

  useEffect(() => { localStorage.setItem(CHAT_KEY, JSON.stringify(lines)); }, [lines]);
  useEffect(() => { log.current?.scrollTo?.({ top: log.current.scrollHeight }); }, [lines, busy, open]);

  const productById = (id: string) => products.find((item) => item.id === id);

  const offerLine = [...lines].reverse().find((line) => line.awaitingView && line.productIds?.[0]);
  const offered = offerLine?.productIds?.[0] ? productById(offerLine.productIds[0]) : undefined;

  const clearAwaiting = () => setLines((curr) => curr.map((line) => line.awaitingView ? { ...line, awaitingView: false } : line));

  const openProduct = (product: Product) => {
    clearAwaiting();
    setLines((curr) => [...curr, {
      id: newId(),
      role: "assistant",
      text: `Opening the product page for ${product.name}.`,
    }]);
    navigate(`/product/${product.id}`);
  };

  const declineProduct = (product: Product) => {
    clearAwaiting();
    setLines((curr) => [...curr, {
      id: newId(),
      role: "assistant",
      text: `No problem — we can keep looking. What else would you like instead of ${product.name}?`,
    }]);
  };

  const sendTurn = async (text: string) => {
    if (busy) return;
    const userLine: ChatLine = { id: newId(), role: "user", text };
    const history = [...linesRef.current, userLine];
    setLines(history);
    setBusy(true);
    try {
      const result = await sendAssistantChat({
        messages: history.map((line) => ({ role: line.role, content: line.text })),
        warehouse: { id: warehouse.id, name: warehouse.name },
      });
      const matched = result.recommendations
        .map((item) => productById(item.id))
        .filter((item): item is Product => Boolean(item));
      const primary = matched[0];
      let reply = result.reply.trim();
      if (primary && (result.askToView || matched.length) && !replyAsksToView(reply)) {
        reply = `${reply} ${viewQuestion(primary)}`.trim();
      }
      setLines((curr) => [...curr, {
        id: newId(),
        role: "assistant",
        text: reply,
        productIds: matched.map((item) => item.id),
        awaitingView: Boolean(primary),
      }]);
    } catch {
      setLines((curr) => [...curr, {
        id: newId(),
        role: "assistant",
        text: "I couldn't reach the assistant just now. Check that the API has an XAI_API_KEY, then try again.",
      }]);
    } finally {
      setBusy(false);
    }
  };

  const handleUserText = async (text: string) => {
    if (offered && isAffirmative(text)) {
      setLines((curr) => [...curr, { id: newId(), role: "user", text }]);
      openProduct(offered);
      return;
    }
    if (offered && isNegative(text)) {
      setLines((curr) => [...curr, { id: newId(), role: "user", text }]);
      declineProduct(offered);
      return;
    }
    await sendTurn(text);
  };

  useEffect(() => {
    if (!open || !pending) return;
    if (handledPending.current === pending.id) return;
    handledPending.current = pending.id;
    onConsumed();
    void handleUserText(pending.text);
  }, [open, pending]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void handleUserText(text);
  };

  return <>
    {!open && <div className="assistant">
      <button
        type="button"
        className={expanded ? "assistant-launch is-expanded" : "assistant-launch"}
        aria-label="Digital assistant"
        onMouseEnter={() => setExpanded(true)}
        onMouseLeave={() => setExpanded(false)}
        onFocus={() => setExpanded(true)}
        onBlur={() => setExpanded(false)}
        onClick={onOpen}
      >
        <span className="assistant-prompt">
          <b>Would you like to talk to the digital assistant?</b>
          <small>Get help finding items, stock, and orders</small>
        </span>
        <span className="assistant-icon"><HeadsetIcon /></span>
      </button>
    </div>}
    {open && <section className="assistant-panel" role="dialog" aria-modal="true" aria-labelledby="assistant-title">
      <header className="assistant-head">
        <span className="assistant-avatar"><HeadsetIcon size={16} /></span>
        <div>
          <h2 id="assistant-title">Digital Assistant</h2>
          <p>Here to help with shopping</p>
        </div>
        <button className="assistant-close" aria-label="Close assistant" onClick={onClose}>×</button>
      </header>
      <div className="assistant-log" ref={log} aria-live="polite">
        {lines.length === 0 && !busy && <p className="assistant-empty">Ask what you need. I can recommend items from this warehouse and open the product page if you want to see it.</p>}
        {lines.map((line) => {
          const recs = (line.productIds ?? []).map(productById).filter((item): item is Product => Boolean(item));
          const isOffer = line.awaitingView && offerLine?.id === line.id && offered;
          return (
            <div className="assistant-turn" key={line.id}>
              <p className={`bubble ${line.role}`}>{line.text}</p>
              {recs.length > 0 && <div className="assistant-chips">{recs.map((product) =>
                <button type="button" className="assistant-chip" key={product.id} onClick={() => openProduct(product)}>
                  <img src={product.image} alt="" />
                  <div>
                    <b>{product.name}</b>
                    <small>Member price ${(product.memberPrice || 0).toFixed(2)} · {warehouse.name}</small>
                  </div>
                </button>
              )}</div>}
              {isOffer && offered && <div className="assistant-actions">
                <button type="button" className="primary" onClick={() => {
                  setLines((curr) => [...curr, { id: newId(), role: "user", text: "Yes" }]);
                  openProduct(offered);
                }}>Yes, show product page</button>
                <button type="button" className="secondary" onClick={() => {
                  setLines((curr) => [...curr, { id: newId(), role: "user", text: "Not now" }]);
                  declineProduct(offered);
                }}>Not now</button>
              </div>}
            </div>
          );
        })}
        {busy && <p className="bubble assistant is-pending">Looking through the warehouse catalog…</p>}
      </div>
      <form className="assistant-dock" onSubmit={submit}>
        <div className="assistant-wave" aria-hidden="true">{[8, 16, 28, 18, 34, 14, 24, 10, 20, 12].map((h, i) => <i key={i} style={{ height: h }} />)}</div>
        <label className="assistant-field">Ask the assistant<input value={input} onChange={e => setInput(e.target.value)} placeholder="Ask about items, stock, or your cart" disabled={busy} /></label>
        <button className="primary" type="submit" disabled={busy}>Send</button>
        <small>{offered ? "Say yes to open the product page, or ask for something else" : "Recommendations stay in this chat as you shop"}</small>
      </form>
    </section>}
  </>;
}
