# Costco Commerce Replica API

Demo-only commerce backend built with Node 22, TypeScript, Hono, Drizzle ORM, and embedded PGlite. It uses fake payments and local data only.

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

The API listens on `http://localhost:3001`. PGlite data is stored in `./data/costco` by default and is created and seeded on first boot. Copy `.env.example` to `.env` and set `XAI_API_KEY` so the digital assistant can call Grok.

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start with file watching |
| `npm start` | Start the API |
| `npm run typecheck` | Type-check source and tests |
| `npm test` | Run the Vitest integration suite |
| `npm run db:reset` | Delete, recreate, and reseed local data |

## Demo accounts

All demo accounts use password `CostcoDemo123!`.

| Email | Membership number | Tier |
| --- | --- | --- |
| `alex.johnson@example.com` | `111000000001` | Executive |
| `jamie.chen@example.com` | `111000000002` | Gold Star |
| `morgan.davis@example.com` | `111000000003` | Executive |
| `taylor.smith@example.com` | `111000000004` | Business |
| `casey.martinez@example.com` | `111000000005` | Gold Star |

Staff accounts use the same password and sign in through `POST /auth/staff-login` or the storefront **Customer Service** banner.

| Email | Role |
| --- | --- |
| `service@costco.demo` | Customer service lead |
| `warehouse@costco.demo` | Warehouse operations |

## API contract

Successful responses use `{ "data": ..., "meta": ... }`; `meta` appears for lists and pagination. Errors use:

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "Requested quantity is not available",
    "details": { "available": 0 }
  }
}
```

Authenticated routes require `Authorization: Bearer <token>`. Guest cart routes require `X-Guest-Cart-Id`, returned by `POST /cart/guest`. Pass that ID as `guestCartId` to register/login to merge the cart.

### Endpoints

- `GET /health`
- `POST /assistant/chat` with `{ messages, warehouse, cart?, image? }` — Kirk recommendations, cart actions, unmet-demand capture. Requires `XAI_API_KEY`. If `api.x.ai` is unreachable, Kirk answers from the local catalog.
- `POST /assistant/imagine` — Imagine category heroes or a cart/spread image
- `POST /assistant/voice/session` and `WS /assistant/voice/live` — live Grok Voice proxy
- `GET /kirk/home` — history category suggestions + Imagine heroes
- `POST /kirk/feedback` — member feedback → Linear + cloud agent + GrokBot summary
- `POST /kirk/demand` — unmet intent + X sourcing queue
- `GET /admin/kirk/purchases` and `POST /admin/kirk/purchases/:id/decide` — human purchase approval
- `POST /kirk/preorders` — preorder after approval (email + in-app notify)
- `GET /warehouses?q=&state=&zip=`
- `GET /warehouses/:id`
- `GET /categories`
- `GET /products?search=&category=&sort=featured|price_asc|price_desc|rating|name&page=&pageSize=&inStock=&warehouseId=&deliveryZip=`
- `GET /products/:id` (ID or slug)
- `POST /auth/register` with `email`, `password`, `firstName`, `lastName`, optional `membershipNumber` and `guestCartId`
- `POST /auth/login` with `email`, `password`, optional `guestCartId`
- `POST /auth/logout`
- `GET /me`
- `PATCH /me/profile`
- `POST /cart/guest`
- `GET /cart`
- `POST /cart/items` with `productId`, `quantity`, optional `warehouseId`
- `PATCH /cart/items/:itemId` with `quantity`
- `DELETE /cart/items/:itemId`
- `POST /checkout` with `warehouseId`, `fulfillmentType`, optional `shippingAddress`, and masked `payment`
- `GET /orders`
- `GET /orders/:id` (ID or order number)
- `GET /orders/:id/returns`
- `POST /orders/:id/returns`
- `GET /returns/:id` (ID or return number)
- `POST /auth/staff-login` with `email` and `password` (staff only)
- `GET /admin/overview`
- `GET /admin/inventory?warehouseId=&q=&lowStock=&page=&pageSize=`
- `PATCH /admin/inventory/:id` with `quantity`
- `GET /admin/orders?status=&q=`
- `GET /admin/orders/:id`
- `PATCH /admin/orders/:id` with `status`
- `POST /admin/orders/:id/discounts` with `reason` and either `discountId` or `type` + `value`
- `GET /admin/returns?status=&q=`
- `PATCH /admin/returns/:id` with `status` and optional `note`
- `GET /admin/discounts?status=`
- `POST /admin/discounts`
- `PATCH /admin/discounts/:id`

Staff routes require a staff bearer session. Completing a refund return restocks the fulfilling warehouse. Discretionary discounts require a reason and reduce the remaining order total.

Checkout accepts payment metadata only:

```json
{
  "brand": "Visa",
  "last4": "4242",
  "expMonth": 12,
  "expYear": 2030
}
```

Full card numbers and CVC are rejected and never stored. Checkout validates and decrements all warehouse inventory in one database transaction. Return requests support `return` or `replace`, `warehouse` or `shipping_label`, item quantities, 90-day eligibility, ownership enforcement, duplicate quantity prevention, and status history.

## Seed data

The seed contains the original 50 generated products across 10 categories, plus 150 Costco.com catalog items (50 electronics, 50 furniture, 50 household) with real item numbers, descriptions, and specification tables. Each catalog item has two placeholder media records and a different on-hand quantity at every warehouse. The seed also includes 8 US warehouses, demo members, addresses and carts, and orders/shipments/returns in multiple states.
