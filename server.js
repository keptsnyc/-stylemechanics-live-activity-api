import { createServer } from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || "";
const ACTIVITY_API_KEY = process.env.ACTIVITY_API_KEY || "";
const MAX_BODY_BYTES = 1_000_000;
const MAX_RECENT_EVENTS = 100;
const MAX_SEEN_ORDER_IDS = 500;

const defaultOrigins = [
  "https://style-mechanics.com",
  "https://www.style-mechanics.com"
];

const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || defaultOrigins.join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

const clients = new Set();
const recentEvents = [];
const seenOrderIds = new Set();

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers
  });
  res.end(body);
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-activity-key",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safeEqual(left, right) {
  const a = Buffer.from(left || "", "utf8");
  const b = Buffer.from(right || "", "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyShopifyHmac(rawBody, receivedHmac, secret) {
  if (!secret || !receivedHmac) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  return safeEqual(expected, receivedHmac);
}

function cleanText(value, maxLength = 80) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

export function sanitizeShopifyOrder(order) {
  const location = order?.shipping_address || order?.billing_address || {};
  const rawOrderId = order?.id ?? order?.admin_graphql_api_id;
  const orderId = ["string", "number", "bigint"].includes(typeof rawOrderId)
    ? String(rawOrderId).slice(0, 100)
    : null;

  return {
    id: randomUUID(),
    type: "purchase",
    orderId,
    city: cleanText(location.city),
    region: cleanText(location.province_code || location.province),
    country: cleanText(location.country_code || location.country),
    occurredAt: new Date().toISOString()
  };
}

function rememberEvent(event) {
  recentEvents.push(event);
  if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.shift();

  if (event.orderId) {
    seenOrderIds.add(event.orderId);
    if (seenOrderIds.size > MAX_SEEN_ORDER_IDS) {
      const oldest = seenOrderIds.values().next().value;
      seenOrderIds.delete(oldest);
    }
  }
}

function broadcast(event) {
  const packet = `event: purchase\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(packet);
}

function publish(event) {
  if (event.orderId && seenOrderIds.has(event.orderId)) return false;
  rememberEvent(event);
  broadcast(event);
  return true;
}

function openEventStream(req, res) {
  const headers = corsHeaders(req);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...headers
  });
  res.write(": connected\n\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
}

function hasValidActivityKey(req) {
  return Boolean(ACTIVITY_API_KEY) && safeEqual(req.headers["x-activity-key"], ACTIVITY_API_KEY);
}

async function handleShopifyWebhook(req, res) {
  if (!SHOPIFY_WEBHOOK_SECRET) {
    sendJson(res, 503, { ok: false, error: "Webhook receiver is not configured" });
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["x-shopify-hmac-sha256"];
  if (!verifyShopifyHmac(rawBody, signature, SHOPIFY_WEBHOOK_SECRET)) {
    sendJson(res, 401, { ok: false });
    return;
  }

  const topic = String(req.headers["x-shopify-topic"] || "").toLowerCase();
  if (topic && topic !== "orders/paid") {
    sendJson(res, 202, { ok: true, ignored: true });
    return;
  }

  let order;
  try {
    order = JSON.parse(rawBody.toString("utf8"));
  } catch {
    sendJson(res, 400, { ok: false });
    return;
  }

  const event = sanitizeShopifyOrder(order);
  const published = publish(event);
  sendJson(res, 200, { ok: true, duplicate: !published });
}

async function handleManualPurchase(req, res) {
  if (!hasValidActivityKey(req)) {
    sendJson(res, 401, { ok: false });
    return;
  }

  const rawBody = await readRawBody(req);
  let input;
  try {
    input = JSON.parse(rawBody.toString("utf8"));
  } catch {
    sendJson(res, 400, { ok: false });
    return;
  }

  const event = {
    id: randomUUID(),
    type: "purchase",
    orderId: cleanText(input.orderId, 100),
    city: cleanText(input.city),
    region: cleanText(input.region),
    country: cleanText(input.country),
    occurredAt: new Date().toISOString()
  };

  const published = publish(event);
  sendJson(res, 200, { ok: true, duplicate: !published, event });
}

export function createAppServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const cors = corsHeaders(req);

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, service: "stylemechanics-live-activity-api" }, cors);
        return;
      }

      if (req.method === "GET" && url.pathname === "/events") {
        openEventStream(req, res);
        return;
      }

      if (req.method === "GET" && url.pathname === "/recent") {
        sendJson(res, 200, { events: recentEvents }, cors);
        return;
      }

      if (req.method === "POST" && url.pathname === "/webhooks/shopify/orders-paid") {
        await handleShopifyWebhook(req, res);
        return;
      }

      if (req.method === "POST" && url.pathname === "/purchase") {
        await handleManualPurchase(req, res);
        return;
      }

      sendJson(res, 404, { ok: false, error: "Not found" }, cors);
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, error.statusCode || 500, { ok: false });
      } else {
        res.end();
      }
    }
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  createAppServer().listen(PORT, "0.0.0.0", () => {
    console.log(`StyleMechanics live activity API listening on port ${PORT}`);
  });
}
