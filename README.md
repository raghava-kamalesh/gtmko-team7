# Costco Commerce Replica

An internal demonstration storefront inspired by Costco.com. It includes a
warehouse-aware catalog, member accounts, cart and checkout, order tracking,
and return or replacement workflows. Customer service staff can open the
operations console from **Customer Service** in the top banner to manage
warehouse stock, orders, returns, and discretionary discounts.

This project is an independent prototype. It is not affiliated with, endorsed
by, or operated by Costco Wholesale Corporation. All transactions and member
data are simulated.

## Stack

- `frontend`: React, TypeScript, Vite, React Router, Vitest
- `backend`: Hono, TypeScript, Drizzle ORM, PGlite, Vitest

## Run locally

Node.js 22 or newer is required.

```bash
npm install
npm run dev
```

- Storefront: http://localhost:5173
- API: http://localhost:3001
- Operations: click **Customer Service** in the top banner, then sign in as
  `service@costco.demo` / `CostcoDemo123!`

The backend creates and seeds its embedded database on first boot, including 150
Costco.com catalog items in electronics, furniture, and household. Reset with
`npm run db:reset -w backend` after catalog changes. See `backend/README.md`
for demo member and staff credentials and API details.

## Quality checks

```bash
npm test
npm run build
```
