import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  captureKirkDemand,
  createVoiceSession,
  imagineCart,
  sendAssistantChat,
  submitKirkFeedback,
} from "./api";
import { useStore } from "./store";
import type { Product } from "./types";
import { KirkVoiceSession, type VoiceStatus } from "./voice-client";

type AssistantApi = { openAssistant: (prompt?: string) => void };
const AssistantContext = createContext<AssistantApi>({ openAssistant: () => {} });
export const useAssistant = () => useContext(AssistantContext);

export type ChatLine = {
  id: string;
  role: "user" | "assistant";
  text: string;
  productIds?: string[];
  awaitingView?: boolean;
  imageUrl?: string;
  imagineUrl?: string;
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
    if (prompt) {
      const current = readLines();
      const last = current[current.length - 1];
      if (!last || last.role !== "user" || last.text !== prompt) {
        localStorage.setItem(CHAT_KEY, JSON.stringify([...current, { id: newId(), role: "user", text: prompt }]));
      }
      setPending({ id: newId(), text: prompt });
    } else {
      setPending(undefined);
    }
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
  const { products, warehouse, cart, add, cartCount, cartTotal, user } = useStore();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<ChatLine[]>(readLines);
  const [busy, setBusy] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackType, setFeedbackType] = useState<"bug" | "wish" | "interaction">("bug");
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackNote, setFeedbackNote] = useState("");
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle");
  const [voiceDetail, setVoiceDetail] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const linesRef = useRef(lines);
  const handledPending = useRef<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const voiceRef = useRef<KirkVoiceSession | null>(null);
  linesRef.current = lines;

  useEffect(() => { localStorage.setItem(CHAT_KEY, JSON.stringify(lines)); }, [lines]);
  useEffect(() => { log.current?.scrollTo?.({ top: log.current.scrollHeight }); }, [lines, busy, open]);

  const productById = (id: string) => products.find((item) => item.id === id);
  const memberKey = user?.email ?? "demo";

  const offerLine = [...lines].reverse().find((line) => line.awaitingView && line.productIds?.[0]);
  const offered = offerLine?.productIds?.[0] ? productById(offerLine.productIds[0]) : undefined;

  const clearAwaiting = () => setLines((curr) => curr.map((line) => line.awaitingView ? { ...line, awaitingView: false } : line));

  const openProduct = (product: Product) => {
    clearAwaiting();
    setLines((curr) => [...curr, { id: newId(), role: "assistant", text: `Opening the product page for ${product.name}.` }]);
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

  const applyCartActions = (actions: Array<{ productId: string; quantity: number }> | undefined) => {
    for (const action of actions ?? []) {
      if (productById(action.productId)) add(action.productId, action.quantity);
    }
  };

  useEffect(() => {
    if (open) setLines(readLines());
  }, [open]);

  const sendTurn = async (text: string, image?: { mimeType: string; data: string; preview: string }, options?: { userAlreadyListed?: boolean }) => {
    if (busy) return;
    const history = options?.userAlreadyListed
      ? readLines()
      : [...linesRef.current, { id: newId(), role: "user" as const, text, imageUrl: image?.preview }];
    setLines(history);
    setBusy(true);
    try {
      const result = await sendAssistantChat({
        messages: history.map((line) => ({ role: line.role, content: line.text })),
        warehouse: { id: warehouse.id, name: warehouse.name },
        cart: cart.map((item) => {
          const product = productById(item.productId);
          return { productId: item.productId, name: product?.name, brand: product?.brand, quantity: item.quantity };
        }),
        memberKey,
        image: image ? { mimeType: image.mimeType, data: image.data } : undefined,
      });
      applyCartActions(result.cartActions);
      const matched = result.recommendations
        .map((item) => productById(item.id))
        .filter((item): item is Product => Boolean(item));
      const primary = matched[0];
      let reply = result.reply.trim();
      if (primary && (result.askToView || matched.length) && !replyAsksToView(reply)) {
        reply = `${reply} ${viewQuestion(primary)}`.trim();
      }
      if (result.unmetDemand) {
        await captureKirkDemand({ rawText: result.unmetDemand.rawText, category: result.unmetDemand.category, memberKey }).catch(() => undefined);
        reply = `${reply} I logged that as unmet demand for merch to source.`.trim();
      }
      setLines((curr) => [...curr, {
        id: newId(),
        role: "assistant",
        text: reply,
        productIds: matched.map((item) => item.id),
        awaitingView: Boolean(primary),
        imagineUrl: result.imagineUrl,
      }]);
    } catch {
      setLines((curr) => [...curr, {
        id: newId(),
        role: "assistant",
        text: "I couldn't reach Kirk just now. Check that the API has an XAI_API_KEY, then try again.",
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
    const text = pending.text;
    onConsumed();
    void sendTurn(text, undefined, { userAlreadyListed: true });
  }, [open, pending]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void handleUserText(text);
  };

  const onPickImage = async (file: File) => {
    const data = await file.arrayBuffer();
    const bytes = btoa(String.fromCharCode(...new Uint8Array(data)));
    const preview = URL.createObjectURL(file);
    await sendTurn(input.trim() || "What should I add from this photo?", {
      mimeType: file.type || "image/jpeg",
      data: bytes,
      preview,
    });
    setInput("");
  };

  const requestSpread = async () => {
    if (busy) return;
    setBusy(true);
    setLines((curr) => [...curr, { id: newId(), role: "user", text: "Visualize my current cart as a party spread." }]);
    try {
      const result = await imagineCart(cart.map((item) => {
        const product = productById(item.productId);
        return { productId: item.productId, name: product?.name, brand: product?.brand, imageUrl: product?.image, quantity: item.quantity };
      }));
      setLines((curr) => [...curr, {
        id: newId(),
        role: "assistant",
        text: cart.length ? "Here is an Imagine spread grounded in the SKUs in your cart." : "Add a few items first and I can picture the table.",
        imagineUrl: result.url,
      }]);
    } catch {
      setLines((curr) => [...curr, { id: newId(), role: "assistant", text: "I couldn't generate the cart spread. Try again in a moment." }]);
    } finally {
      setBusy(false);
    }
  };

  const toggleVoice = async () => {
    if (voiceStatus === "live" || voiceStatus === "connecting" || voiceStatus === "reconnecting") {
      voiceRef.current?.stop();
      voiceRef.current = null;
      return;
    }
    const session = new KirkVoiceSession({
      onStatus: (status, detail) => {
        setVoiceStatus(status);
        setVoiceDetail(detail ?? "");
      },
      onTranscript: (role, text) => {
        if (!text.trim()) return;
        setLines((curr) => [...curr, { id: newId(), role, text }]);
      },
      onTool: (name, args) => {
        if (name === "add_to_cart" && typeof args.product_id === "string") {
          add(args.product_id, typeof args.quantity === "number" ? args.quantity : 1);
        }
        if (name === "capture_unmet_demand" && typeof args.raw_text === "string") {
          void captureKirkDemand({ rawText: args.raw_text, category: typeof args.category === "string" ? args.category : undefined, memberKey });
        }
      },
    });
    voiceRef.current = session;
    try {
      const descriptor = await createVoiceSession({
        warehouse: { id: warehouse.id, name: warehouse.name },
        cartSummary: cart.map((item) => `${item.quantity}× ${productById(item.productId)?.name ?? item.productId}`).join("; "),
      });
      if (!descriptor.configured) {
        setVoiceStatus("error");
        setVoiceDetail("Live voice needs XAI_API_KEY on the API server.");
        return;
      }
      await session.start(descriptor);
    } catch {
      setVoiceStatus("error");
      setVoiceDetail("Could not start a Grok Voice session.");
    }
  };

  const sendFeedback = async (e: FormEvent) => {
    e.preventDefault();
    if (!feedbackText.trim()) return;
    try {
      const result = await submitKirkFeedback({
        type: feedbackType,
        details: feedbackText.trim(),
        transcript: linesRef.current.slice(-12),
        memberKey,
      });
      setFeedbackNote(`Thanks — Kirk sent this to engineering. ${result.linearIdentifier ?? "Ticket"} is ready for review.`);
      setFeedbackText("");
      setFeedbackOpen(false);
    } catch {
      setFeedbackNote("Feedback could not be sent. Try again.");
    }
  };

  return <>
    {!open && <div className="assistant">
      <button
        type="button"
        className={expanded ? "assistant-launch is-expanded" : "assistant-launch"}
        aria-label="Kirk assistant"
        onMouseEnter={() => setExpanded(true)}
        onMouseLeave={() => setExpanded(false)}
        onFocus={() => setExpanded(true)}
        onBlur={() => setExpanded(false)}
        onClick={onOpen}
      >
        <span className="assistant-prompt">
          <b>Would you like to talk to Kirk?</b>
          <small>Chat, live voice, photos, and Imagine</small>
        </span>
        <span className="assistant-icon"><HeadsetIcon /></span>
      </button>
    </div>}
    {open && <section className="assistant-panel" role="dialog" aria-modal="true" aria-labelledby="assistant-title">
      <header className="assistant-head">
        <span className="assistant-avatar"><HeadsetIcon size={16} /></span>
        <div>
          <h2 id="assistant-title">Kirk</h2>
          <p>Warehouse shopping assistant</p>
        </div>
        <button className="assistant-close" aria-label="Close assistant" onClick={() => { voiceRef.current?.stop(); onClose(); }}>×</button>
      </header>
      <div className="kirk-toolbar">
        <button type="button" className={voiceStatus === "live" ? "primary" : "secondary"} onClick={() => void toggleVoice()} aria-pressed={voiceStatus === "live"}>
          {voiceStatus === "live" ? "Stop voice" : voiceStatus === "connecting" || voiceStatus === "reconnecting" ? "Connecting…" : "Start voice"}
        </button>
        <button type="button" className="secondary" onClick={() => fileRef.current?.click()}>Upload photo</button>
        <button type="button" className="secondary" onClick={() => void requestSpread()}>Imagine spread</button>
        <button type="button" className="secondary" onClick={() => setFeedbackOpen((value) => !value)}>Feedback</button>
        <button type="button" className="text-btn" onClick={() => navigate("/cart")}>Cart · {cartCount}</button>
      </div>
      {voiceDetail && <p className={`kirk-voice-status is-${voiceStatus}`} role="status">{voiceDetail}</p>}
      {feedbackOpen && <form className="kirk-feedback" onSubmit={sendFeedback}>
        <label>Type
          <select aria-label="Feedback type" value={feedbackType} onChange={(e) => setFeedbackType(e.target.value as typeof feedbackType)}>
            <option value="bug">Bug</option>
            <option value="wish">Wish</option>
            <option value="interaction">Interaction</option>
          </select>
        </label>
        <label>Details
          <textarea aria-label="Feedback details" rows={3} value={feedbackText} onChange={(e) => setFeedbackText(e.target.value)} required placeholder="What happened, or what do you wish Kirk did?" />
        </label>
        <button className="primary" type="submit">Send to engineering</button>
      </form>}
      {feedbackNote && <p className="kirk-feedback-note" role="status">{feedbackNote}</p>}
      <div className="assistant-log" ref={log} aria-live="polite">
        {lines.length === 0 && !busy && <p className="assistant-empty">Ask Kirk what you need. I can recommend warehouse items, add them to your cart, read a photo, or Imagine the spread.</p>}
        {lines.map((line) => {
          const recs = (line.productIds ?? []).map(productById).filter((item): item is Product => Boolean(item));
          const isOffer = line.awaitingView && offerLine?.id === line.id && offered;
          return (
            <div className="assistant-turn" key={line.id}>
              <p className={`bubble ${line.role}`}>{line.text}</p>
              {line.imageUrl && <img className="kirk-upload-preview" src={line.imageUrl} alt="Uploaded for Kirk" />}
              {line.imagineUrl && <img className="kirk-imagine" src={line.imagineUrl} alt="Imagine visualization" />}
              {recs.length > 0 && <div className="assistant-chips">{recs.map((product) =>
                <div className="assistant-chip-wrap" key={product.id}>
                  <button type="button" className="assistant-chip" onClick={() => openProduct(product)}>
                    <img src={product.image} alt="" />
                    <div>
                      <b>{product.name}</b>
                      <small>Member price ${(product.memberPrice || 0).toFixed(2)} · {warehouse.name}</small>
                    </div>
                  </button>
                  <button type="button" className="primary" onClick={() => add(product.id)}>Add to cart</button>
                </div>
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
        <div className={`assistant-wave${voiceStatus === "live" ? " is-live" : ""}`} aria-hidden="true">{[8, 16, 28, 18, 34, 14, 24, 10, 20, 12].map((h, i) => <i key={i} style={{ height: h }} />)}</div>
        <label className="assistant-field">Ask Kirk<input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about items, stock, or your cart" disabled={busy} /></label>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) void onPickImage(file); e.target.value = ""; }} />
        <button className="primary" type="submit" disabled={busy}>Send</button>
        <small>{offered ? "Say yes to open the product page, or ask for something else" : `Cart ${cartCount} · $${cartTotal.toFixed(2)} · Feedback goes to GrokBot`}</small>
      </form>
    </section>}
  </>;
}
