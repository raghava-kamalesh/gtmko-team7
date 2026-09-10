import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./main";

const open = (path = "/") => {
  window.history.pushState({}, "", path);
  return render(<App />);
};

describe("Costco commerce journeys", () => {
  beforeEach(() => localStorage.clear());

  it("selects and persists a warehouse", async () => {
    const user = userEvent.setup(); open();
    await user.click(screen.getByRole("button", { name: /My Warehouse/ }));
    await user.type(screen.getByLabelText(/Search by city/), "Hackensack");
    await user.click(screen.getByRole("button", { name: /Hackensack, NJ/ }));
    expect(screen.getByText("Hackensack", { selector: "b" })).toBeInTheDocument();
    expect(localStorage.getItem("costco-warehouse")).toContain("Hackensack");
  });

  it("renders stock for the selected warehouse and retains cart lines after change", async () => {
    localStorage.setItem("costco-cart", JSON.stringify([{ productId: "3", quantity: 1 }]));
    const user = userEvent.setup(); open("/cart");
    expect(screen.getByText(/Unavailable at Brooklyn/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /My Warehouse/ }));
    await user.click(screen.getByRole("button", { name: /Manhattan, NY/ }));
    expect(screen.getByText(/In stock at Manhattan/)).toBeInTheDocument();
    expect(screen.getByText(/MacBook Air/)).toBeInTheDocument();
  });

  it("adds products and updates cart quantity", async () => {
    const user = userEvent.setup(); open("/product/1");
    await user.click(screen.getAllByRole("button", { name: "Add to Cart" })[0]);
    await user.click(screen.getByRole("link", { name: /Cart/ }));
    expect(screen.getByText(/Bath Tissue/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Increase quantity" }));
    expect(screen.getByText("2", { selector: ".quantity span" })).toBeInTheDocument();
  });

  it("guards checkout and returns to it after sign in", async () => {
    localStorage.setItem("costco-cart", JSON.stringify([{ productId: "1", quantity: 1 }]));
    const user = userEvent.setup(); open("/checkout");
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Email address"), "member@example.com");
    await user.type(screen.getByLabelText("Password"), "secret1");
    await user.click(screen.getByRole("button", { name: "Sign In" }));
    expect(screen.getByRole("heading", { name: "Secure Checkout" })).toBeInTheDocument();
  });

  it("places an order and submits a return", async () => {
    localStorage.setItem("costco-user", JSON.stringify({ id: "u1", email: "m@example.com", name: "Member" }));
    localStorage.setItem("costco-cart", JSON.stringify([{ productId: "1", quantity: 1 }]));
    const user = userEvent.setup(); open("/checkout");
    for (const [label, value] of [["Name","Test Member"],["Address","1 Main St"],["City","Brooklyn"],["State","NY"],["Zip","11232"]]) await user.type(screen.getByLabelText(label), value);
    await user.click(screen.getByRole("button", { name: /Continue/ }));
    await user.type(screen.getByLabelText("Card number"), "4242 4242 4242 4242");
    await user.type(screen.getByLabelText("Expiration"), "12/30");
    await user.type(screen.getByLabelText("Security code"), "123");
    await user.click(screen.getByRole("button", { name: "Place order" }));
    expect(screen.getByText(/Thanks for your order/)).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Return items" }));
    await user.selectOptions(screen.getByLabelText("Reason"), "Changed my mind");
    await user.click(screen.getByRole("button", { name: /Submit return/ }));
    expect(within(screen.getByText("Return requested").closest(".notice")!).getByText("Return requested")).toBeInTheDocument();
  });

  it("lists Costco household catalog items", () => {
    open("/category/household");
    expect(screen.getByRole("heading", { name: "Household" })).toBeInTheDocument();
    expect(screen.getByText("50 results")).toBeInTheDocument();
    expect(screen.getByText(/Ultra Clean HE Liquid Laundry Detergent/)).toBeInTheDocument();
  });

  it("shows catalog specifications and per-warehouse stock on a product page", () => {
    open("/product/100525846");
    expect(screen.getByRole("heading", { name: /Ultra Clean HE Liquid Laundry Detergent/ })).toBeInTheDocument();
    expect(screen.getByText("Item #100525846")).toBeInTheDocument();
    expect(screen.getByText("194 fl oz")).toBeInTheDocument();
    expect(screen.getAllByText("Brooklyn").length).toBeGreaterThan(0);
    expect(screen.getByText("Manhattan")).toBeInTheDocument();
    expect(screen.getAllByText(/\d+ on hand/).length).toBeGreaterThan(1);
  });

  it("shows the Kirk home row and opens the assistant", async () => {
    const user = userEvent.setup(); open();
    expect(screen.getByRole("button", { name: "Open Kirk" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Grocery & snacks" })).toBeInTheDocument();
    const launch = screen.getByRole("button", { name: "Kirk assistant" });
    expect(screen.getByText(/Would you like to talk to Kirk/)).not.toBeVisible();
    await user.hover(launch);
    expect(screen.getByText(/Would you like to talk to Kirk/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open Kirk" }));
    expect(screen.getByRole("heading", { name: "Kirk" })).toBeInTheDocument();
  });

  it("keeps a Grok transcript and opens a recommended product page after the member agrees", async () => {
    const sony = {
      id: "9565020",
      name: "Sony 65\" Class - BRAVIA 2 II Series - 4K UHD Smart TV",
      brand: "Sony",
      memberPrice: 698,
      category: "electronics",
      inStock: true,
    };
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/assistant/chat")) {
        bodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({
          data: {
            reply: "The Sony 65-inch BRAVIA is $698.00 and in stock at Brooklyn. Would you like to see the product page?",
            recommendations: [sony],
            askToView: true,
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: { message: url } }), { status: 404 });
    });
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole("button", { name: "Kirk assistant" }));
    const panel = screen.getByRole("dialog", { name: "Kirk" });
    await user.type(within(panel).getByPlaceholderText(/Ask about items/), "I need a 65 inch TV");
    await user.click(within(panel).getByRole("button", { name: "Send" }));
    expect(await within(panel).findByText(/Sony 65-inch BRAVIA/)).toBeInTheDocument();
    expect(within(panel).getByText("I need a 65 inch TV")).toBeInTheDocument();
    const log = panel.querySelector(".assistant-log");
    expect(log).toBeTruthy();
    const messages = [...log!.querySelectorAll(".assistant-msg")].map((node) => node.textContent ?? "");
    expect(messages[0]).toContain("I need a 65 inch TV");
    expect(messages[1]).toContain("Sony 65-inch BRAVIA");
    expect(within(panel).getByRole("button", { name: "Can't find what you need?" })).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Yes, show product page" })).not.toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: /Sony 65/ }));
    expect(await screen.findByRole("heading", { name: /Sony 65" Class - BRAVIA 2 II Series/ })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/product/9565020");
    const stillOpen = screen.getByRole("dialog", { name: "Kirk" });
    expect(within(stillOpen).getByText(/Opening the product page/)).toBeInTheDocument();
    expect(within(stillOpen).getByText("I need a 65 inch TV")).toBeInTheDocument();
    const later = [...stillOpen.querySelectorAll(".assistant-msg")].map((node) => node.textContent ?? "");
    expect(later.findIndex((text) => text.includes("Open Sony"))).toBeLessThan(later.findIndex((text) => /Opening the product page/.test(text)));
    expect(bodies[0]).toMatchObject({
      messages: [{ role: "user", content: "I need a 65 inch TV" }],
      warehouse: { name: "Brooklyn" },
    });
  });

  it("keeps chat moving and swaps in a product photo when Imagine returns", async () => {
    const imageIds: string[][] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/assistant/chat")) {
        return new Response(JSON.stringify({
          data: {
            reply: "The Sony 65-inch BRAVIA is $698.00 and in stock at Brooklyn.",
            recommendations: [{
              id: "9565020",
              name: "Sony 65\" Class - BRAVIA 2 II Series - 4K UHD Smart TV",
              brand: "Sony",
              memberPrice: 698,
              category: "electronics",
              inStock: true,
            }],
            askToView: true,
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/kirk/product-images")) {
        imageIds.push(JSON.parse(String(init?.body ?? "{}")).ids);
        await new Promise((resolve) => setTimeout(resolve, 40));
        return new Response(JSON.stringify({
          data: [{ productId: "9565020", url: "/api/kirk/media/product-9565020.png", source: "imagine", cached: false }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: { message: url } }), { status: 404 });
    });
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole("button", { name: "Kirk assistant" }));
    const panel = screen.getByRole("dialog", { name: "Kirk" });
    await user.type(within(panel).getByPlaceholderText(/Ask about items/), "I need a 65 inch TV");
    await user.click(within(panel).getByRole("button", { name: "Send" }));
    expect(await within(panel).findByText(/Sony 65-inch BRAVIA is \$698/)).toBeInTheDocument();
    const card = within(panel).getByRole("button", { name: /Sony 65/ });
    expect(card.querySelector("img")?.getAttribute("src")).toMatch(/\/images\/product-/);
    await waitFor(() => {
      expect(card.querySelector("img")?.getAttribute("src")).toBe("/api/kirk/media/product-9565020.png");
    });
    expect(imageIds[0]).toEqual(["9565020"]);
  });

  it("restores the assistant transcript after the panel is closed", async () => {
    localStorage.setItem("costco-assistant-chat", JSON.stringify([
      { id: "u1", role: "user", text: "Need laundry detergent" },
      { id: "a1", role: "assistant", text: "Kirkland Ultra Clean is in stock.", productIds: ["100525846"] },
    ]));
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole("button", { name: "Kirk assistant" }));
    const panel = screen.getByRole("dialog", { name: "Kirk" });
    expect(within(panel).getByText("Need laundry detergent")).toBeInTheDocument();
    expect(within(panel).getByText(/Kirkland Ultra Clean/)).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Close assistant" }));
    await user.click(screen.getByRole("button", { name: "Kirk assistant" }));
    expect(within(screen.getByRole("dialog", { name: "Kirk" })).getByText("Need laundry detergent")).toBeInTheDocument();
  });

  it("adds a Kirk recommendation to the cart and submits an issue report", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/assistant/chat")) {
        return new Response(JSON.stringify({
          data: {
            reply: "Kirkland bath tissue is the warehouse staple.",
            recommendations: [{ id: "1", name: "Kirkland Signature Bath Tissue, 30 Rolls", brand: "Kirkland Signature", memberPrice: 22.07, category: "grocery", inStock: true }],
            askToView: true,
            cartActions: [{ productId: "1", quantity: 1 }],
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/kirk/feedback")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body.details).toMatch(/tissue brand/i);
        return new Response(JSON.stringify({ data: { id: "fb1", linearIdentifier: "KIRK-FEED", status: "ready_for_review" } }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/kirk/home")) {
        return new Response(JSON.stringify({ data: { member: { displayName: "Alex Johnson", unmetInterests: [], history: [] }, suggestions: [], preorderItems: [], notifications: [] } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: { message: url } }), { status: 404 });
    });
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole("button", { name: "Kirk assistant" }));
    const panel = screen.getByRole("dialog", { name: "Kirk" });
    await user.type(within(panel).getByPlaceholderText(/Ask about items/), "Need bath tissue");
    await user.click(within(panel).getByRole("button", { name: "Send" }));
    expect(await within(panel).findByText(/warehouse staple/)).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Add to cart" }));
    await user.click(within(panel).getByRole("button", { name: "Report issue" }));
    expect(within(panel).queryByLabelText("Feedback type")).not.toBeInTheDocument();
    await user.type(within(panel).getByLabelText("Issue details"), "Remember my last tissue brand");
    await user.click(within(panel).getByRole("button", { name: "Submit issue" }));
    expect(await screen.findByText(/KIRK-FEED/)).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Close assistant" }));
    await user.click(screen.getByRole("link", { name: /Cart/ }));
    expect(screen.getByRole("heading", { name: "Shopping Cart" })).toBeInTheDocument();
    expect(screen.getAllByText(/Bath Tissue/).length).toBeGreaterThan(0);
  });

  it("asks to request a missing product and writes the description to merch", async () => {
    const demandBodies: unknown[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/assistant/chat")) {
        return new Response(JSON.stringify({
          data: {
            reply: "I don't have that in this warehouse catalog. Would you like me to request it be added to inventory? You can describe exactly what you want.",
            recommendations: [],
            askToView: false,
            askToRequestInventory: true,
            unmetDemand: null,
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/kirk/demand")) {
        demandBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ data: { request: { id: "pr-1", status: "pending" } } }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/kirk/home")) {
        return new Response(JSON.stringify({ data: { member: { displayName: "Alex Johnson", unmetInterests: [], history: [] }, suggestions: [], preorderItems: [], notifications: [] } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: { message: url } }), { status: 404 });
    });
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole("button", { name: "Kirk assistant" }));
    const panel = screen.getByRole("dialog", { name: "Kirk" });
    await user.type(within(panel).getByPlaceholderText(/Ask about items/), "Do you sell Japanese whisky gift sets?");
    await user.click(within(panel).getByRole("button", { name: "Send" }));
    expect(await within(panel).findByText(/request it be added to inventory/)).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Can't find what you need?" }));
    const requestDialog = screen.getByRole("dialog", { name: "Can't find what you need?" });
    expect(within(requestDialog).getByPlaceholderText(/Tell us what you're looking for/)).toBeInTheDocument();
    await user.type(within(requestDialog).getByLabelText("Stock request details"), "12-year Yamazaki gift box");
    await user.click(within(requestDialog).getByRole("button", { name: "Submit request" }));
    expect(await within(panel).findByText(/They'll see: 12-year Yamazaki gift box/)).toBeInTheDocument();
    expect(demandBodies[0]).toMatchObject({
      rawText: "12-year Yamazaki gift box",
    });
  });

  it("auto-sends a history category prompt from the home row", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/assistant/chat")) {
        bodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ data: { reply: "I can build that snack table.", recommendations: [], askToView: false } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: { message: url } }), { status: 404 });
    });
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole("button", { name: "Grocery & snacks" }));
    const panel = await screen.findByRole("dialog", { name: "Kirk" });
    expect((await within(panel).findAllByText(/snack table/)).length).toBeGreaterThan(0);
    expect(bodies[0]).toMatchObject({ messages: [{ role: "user", content: expect.stringMatching(/snack table/i) }] });
  });

  it("shows preorder notices when the notification bell is opened", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).includes("/kirk/home")) {
        return new Response(JSON.stringify({
          data: {
            member: { displayName: "Alex Johnson", unmetInterests: [], history: [] },
            suggestions: [],
            preorderItems: [{ id: "po-1", name: "Japanese whisky gift set" }],
            notifications: [{
              id: "n1",
              memberKey: "demo",
              title: "Available to preorder",
              body: "Japanese whisky gift set is available to preorder.",
              itemId: "po-1",
              read: false,
            }],
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: { message: String(input) } }), { status: 404 });
    });
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole("button", { name: "Notifications" }));
    const panel = await screen.findByRole("dialog", { name: "In-app notifications" });
    expect(await within(panel).findByText(/Japanese whisky gift set is available to preorder/)).toBeInTheDocument();
  });

  it("opens customer service from the banner and signs staff into operations", async () => {
    const overview = {
      openOrders: 2, deliveredOrders: 3, orderCount: 6, pendingReturns: 1, returnCount: 2,
      lowStock: 4, outOfStock: 1, unitsOnHand: 1200, activeDiscounts: 3, recentOrders: [
        { id: "order-2", orderNumber: "CST-2026-100002", status: "shipped", fulfillmentType: "shipping", subtotal: 183.49, tax: 18.81, discount: 0, total: 202.3, placedAt: "2026-08-20T00:00:00.000Z", member: { email: "alex.johnson@example.com", name: "Alex Johnson", membershipNumber: "111000000001" }, warehouse: { name: "Seattle Warehouse", city: "Seattle", state: "WA" } },
      ],
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { "Content-Type": "application/json" } });
      if (url.includes("/auth/staff-login")) {
        return json({ token: "staff-token", member: { id: "staff-1", email: "service@costco.demo", profile: { firstName: "Priya", lastName: "Nair" } } });
      }
      if (url.includes("/admin/overview")) return json(overview);
      return new Response(JSON.stringify({ error: { message: url } }), { status: 404 });
    });
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole("link", { name: "Customer Service" }));
    expect(screen.getByRole("heading", { name: "Staff sign in" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in to operations" }));
    expect(await screen.findByRole("heading", { name: "Operations overview" })).toBeInTheDocument();
    expect(screen.getByText("Priya Nair")).toBeInTheDocument();
    expect(screen.getByText("CST-2026-100002")).toBeInTheDocument();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
