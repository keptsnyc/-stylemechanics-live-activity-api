# StyleMechanics Cloudflare backend — first migration stage

This directory adds a Worker alongside the original Node sale-alert server. Use branch `cloudflare`, project root `cloudflare`, an empty build command, and deploy command `npx wrangler deploy`. Worker name is `stylemechanics-live`.

The code can deploy before D1 is configured. `/health` reports `not_bound`; tracking endpoints return 503 instead of inventing visitors or resetting the counter. This does not modify a Shopify theme or switch its traffic.

## One-time Cloudflare setup

1. Create a free D1 database named `stylemechanics-live-db`.
2. Copy its database UUID into `wrangler.jsonc`, adding:

```json
"d1_databases": [{"binding":"DB","database_name":"stylemechanics-live-db","database_id":"YOUR_DATABASE_UUID"}]
```

The UUID is an identifier, not an API credential. The binding must live in this configuration before subsequent Git deployments, so Wrangler retains it.

3. Run `schema.sql` in the D1 console. It only creates missing tables and indexes.
4. Add a random runtime secret named `TRACKING_SECRET` in Worker Settings → Variables and Secrets. Generate it in a password manager; do not commit it or paste it into chat. It protects stored IP hashes and private session tokens.
5. Choose and record a counter baseline immediately before switching the storefront. Example SQL:

```sql
INSERT INTO settings(key,value) VALUES('counter_baseline','16259')
ON CONFLICT(key) DO NOTHING;
```

16,259 was the verified Shopify visitor total on October 17, 2026 at about 10:33 AM New York time; refresh that measurement at cutover. New tracking counts sessions with a 30-minute creation window, not Shopify unique visitors. Adding the two is a continuity counter with mixed measurement rules, not an exact reproduction of Shopify analytics. Decide the display label and tracking policy before switching. Tracking is intentionally disabled until the baseline exists.

6. For actual sale events, add runtime `SHOPIFY_WEBHOOK_SECRET` and register the store's `orders/paid` webhook at `/webhooks/shopify/orders-paid`. The receiver verifies the raw-body HMAC, deduplicates orders, and stores only coarse city/region/country and time. It never publishes an order ID, email, name, address, amount, or purchased products. Unknown city coordinates stay null.

## Routes and current scope

- GET `/health`, `/visitor-count`, `/activity`, `/recent`
- POST `/visit`, `/heartbeat`, `/leave`, `/view`, `/cart`
- POST `/webhooks/shopify/orders-paid` (alias `/shopify/order-paid`)

`/visit` returns a private `session_id` for subsequent writes. Public activity uses a separate anonymous id. Never add the private token to public JSON. Visitor IPs are HMAC hashed; geolocation comes from Cloudflare metadata, with missing coordinates retained as unknown. Owner-header sessions and obvious crawler user agents are ignored; this is not comprehensive bot filtering. Browser Origin restrictions are not authentication against scripted clients. Public tracking needs abuse testing and additional rate limits before switching a busy storefront.

This first stage does not implement the old SSE `/events` feed, `/purchase`, `/city-view`, historical imports, complete Shopify analytics syncing, Black Book uploads, moderation, likes, profiles, or stream alerts. The Shopify draft currently uses a historical snapshot and must be adapted and tested against these endpoints before cutover. Its existing globe design is not replaced here.

Keep the old database intact until its data has been exported and checked. Historical Shopify city totals and the existing map remain separate from new Cloudflare sessions until a defined import and cutover avoids double-counting. No old Railway database data is included in this branch.

## Validation and limits

Run `npm test` on Node 24+. Tests execute the SQL against SQLite with a D1-compatible adapter: visit deduplication, presence changes, counter continuity, origin rejection, unknown geography, owner/bot exclusions and webhook validation. Actual Cloudflare deployment and browser integration still require remote verification.

Workers Free and D1 Free have daily request/read/write limits. Repeated polling and heartbeats consume these quotas. This stage stores session rows without automatic pruning: add retention/rollups and monitor usage before prolonged production use. No paid service is required by this configuration; this is not a promise of unlimited capacity or that account upgrades are enabled.
