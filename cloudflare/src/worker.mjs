const ORIGINS = new Set(['https://style-mechanics.com', 'https://www.style-mechanics.com']);
const ACTIVE_MS = 90000;
const SESSION_MS = 1800000;
const DAY = 86400000;
const text = (v, n = 80) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n) : '';
const iso = n => new Date(n).toISOString();
const coordinate = (v, max) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Math.abs(Number(v)) <= max ? Number(v) : null;
const location = r => ({country:r.country || '', region:r.region || '', city:r.city || '', lat:r.lat, lng:r.lng});

function response(request, data, status = 200) {
  const origin = request.headers.get('origin');
  const headers = {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', vary:'Origin', 'x-content-type-options':'nosniff'};
  if (ORIGINS.has(origin)) Object.assign(headers, {'access-control-allow-origin':origin,
    'access-control-allow-methods':'GET, POST, OPTIONS', 'access-control-allow-headers':'content-type,x-sm-owner', 'access-control-max-age':'86400'});
  return new Response(status === 204 ? null : JSON.stringify(data), {status, headers});
}

async function body(request) {
  // Bound the stream itself: Content-Length is optional and untrusted.
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = []; let length = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 65536) { await reader.cancel(); throw Object.assign(new Error('Payload too large'), {status:413}); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  return bytes;
}

async function digest(secret, value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map(v => v.toString(16).padStart(2,'0')).join('');
}

export async function verifyHmac(bytes, signature, secret) {
  if (!secret || !signature) return false;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['verify']);
    const received = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
    return await crypto.subtle.verify('HMAC', key, received, bytes);
  } catch { return false; }
}

async function baseline(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key='counter_baseline'").first();
  const value = Number(row?.value);
  return row && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function visit(request, env, input, now) {
  if (!env.TRACKING_SECRET) return response(request, {ok:false, error:'Tracking secret is not configured'},503);
  const initial = await baseline(env.DB);
  if (initial === null) return response(request, {ok:false, error:'Set counter_baseline before enabling tracking'},503);
  const ip = request.headers.get('cf-connecting-ip');
  if (!ip) return response(request, {ok:false, error:'Visitor metadata unavailable'},503);
  if (/bot|crawler|spider|headless|preview/i.test(request.headers.get('user-agent') || '')) return response(request,{ignored:true});
  // Never store the raw IP. A first-party visitor id can distinguish shared-network devices.
  const key = await digest(env.TRACKING_SECRET, ip + '|' + text(input.visitor_id,128) + '|' + text(request.headers.get('user-agent'),200));
  const cf = request.cf || {};
  const row = {country:text(cf.country), region:text(cf.region), city:text(cf.city), lat:coordinate(cf.latitude,90), lng:coordinate(cf.longitude,180)};
  const lk = JSON.stringify([row.country,row.region,row.city,row.lat,row.lng]);
  // Deterministic per-visitor token makes simultaneous /visit requests deduplicate atomically.
  const last = await env.DB.prepare('SELECT token, created_at FROM sessions WHERE visitor_key=? ORDER BY created_at DESC LIMIT 1').bind(key).first();
  const token = last && last.created_at > now - SESSION_MS ? last.token : await digest(env.TRACKING_SECRET, key + '|' + Math.floor(now / SESSION_MS));
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO sessions(token,public_id,visitor_key,created_at,last_seen,country,region,city,lat,lng) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(token) DO UPDATE SET last_seen=excluded.last_seen,departed=0`).bind(token,id,key,now,now,row.country,row.region,row.city,row.lat,row.lng),
    // Count only the session inserted by this batch, identified by its unique public id.
    env.DB.prepare(`INSERT INTO locations(location_key,country,region,city,lat,lng,lifetime) SELECT ?,?,?,?,?,?,1 WHERE EXISTS(SELECT 1 FROM sessions WHERE public_id=?) ON CONFLICT(location_key) DO UPDATE SET lifetime=lifetime+1`).bind(lk,row.country,row.region,row.city,row.lat,row.lng,id),
    env.DB.prepare(`INSERT INTO settings(key,value) SELECT 'new_sessions','1' WHERE EXISTS(SELECT 1 FROM sessions WHERE public_id=?) ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)`).bind(id)
  ]);
  return response(request,{ok:true,session_id:token,location:row});
}

function publicSession(s) {
  return {id:s.public_id, location:location(s), created_at:iso(s.created_at),last_seen:iso(s.last_seen),state:s.state,current_view:s.current_view};
}

async function activity(db, now) {
  const [live, recent, cells, weekly, paid] = await db.batch([
    db.prepare('SELECT * FROM sessions WHERE last_seen>? AND departed=0 ORDER BY last_seen DESC LIMIT 500').bind(now-ACTIVE_MS),
    db.prepare('SELECT * FROM sessions WHERE last_seen>? ORDER BY last_seen DESC LIMIT 100').bind(now-DAY),
    db.prepare('SELECT * FROM locations ORDER BY lifetime DESC LIMIT 5000'),
    db.prepare('SELECT country,region,city,lat,lng,COUNT(*) AS visits_7d,SUM(CASE WHEN created_at>? THEN 1 ELSE 0 END) AS visits_24h FROM sessions WHERE created_at>? GROUP BY country,region,city,lat,lng').bind(now-DAY,now-7*DAY),
    db.prepare('SELECT * FROM purchases WHERE created_at>? ORDER BY created_at DESC LIMIT 100').bind(now-DAY)
  ]);
  const key = r => JSON.stringify([r.country,r.region,r.city,r.lat,r.lng]);
  const week = new Map(weekly.results.map(r => [key(r),r]));
  const routes = cells.results.map(r => ({...location(r),lifetime:r.lifetime,visits_24h:Number(week.get(key(r))?.visits_24h || 0),visits_7d:Number(week.get(key(r))?.visits_7d || 0)}));
  return {source:'cloudflare',timestamp:iso(now),active:live.results.map(publicSession),recent:recent.results.map(publicSession),routes,
    heat:routes.filter(r=>r.lat!==null&&r.lng!==null),
    purchases:paid.results.map(p=>({id:p.public_id,type:'purchase',location:location(p),occurredAt:iso(p.created_at)}))};
}

async function webhook(request, env, now) {
  if (!env.SHOPIFY_WEBHOOK_SECRET) return response(request,{ok:false,error:'Webhook secret is not configured'},503);
  const raw = await body(request);
  if (!await verifyHmac(raw,request.headers.get('x-shopify-hmac-sha256'),env.SHOPIFY_WEBHOOK_SECRET)) return response(request,{ok:false},401);
  if (request.headers.get('x-shopify-topic') !== 'orders/paid') return response(request,{ok:true,ignored:true},202);
  const order = JSON.parse(new TextDecoder().decode(raw));
  if (!order.id) return response(request,{ok:false,error:'Missing order id'},400);
  const address = order.shipping_address || order.billing_address || {};
  const country = text(address.country_code), region = text(address.province), city = text(address.city);
  const point = await env.DB.prepare('SELECT lat,lng FROM locations WHERE country=? AND region=? AND city=? AND lat IS NOT NULL AND lng IS NOT NULL LIMIT 1').bind(country,region,city).first();
  const dedup = await digest(env.SHOPIFY_WEBHOOK_SECRET,String(order.id));
  const result = await env.DB.prepare('INSERT OR IGNORE INTO purchases(dedup_key,public_id,created_at,country,region,city,lat,lng) VALUES(?,?,?,?,?,?,?,?)').bind(dedup,crypto.randomUUID(),now,country,region,city,point?.lat??null,point?.lng??null).run();
  return response(request,{ok:true,duplicate:result.meta.changes===0});
}

export default {
  async fetch(request,env) {
    const url = new URL(request.url), now = Date.now();
    if (request.method==='OPTIONS') return response(request,null,204);
    const origin = request.headers.get('origin');
    if (origin && !ORIGINS.has(origin)) return response(request,{ok:false,error:'Origin not allowed'},403);
    if (request.method==='GET' && (url.pathname==='/' || url.pathname==='/health')) {
      let database = 'not_bound';
      if (env.DB) { try { await env.DB.prepare('SELECT key FROM settings LIMIT 1').first(); database='ready'; } catch { database='schema_required'; } }
      return response(request,{ok:true,service:'stylemechanics-live',database,tracking_configured:Boolean(env.TRACKING_SECRET),webhooks_configured:Boolean(env.SHOPIFY_WEBHOOK_SECRET)});
    }
    if (!env.DB) return response(request,{ok:false,error:'D1 database binding DB is required'},503);
    try {
      if (request.method==='GET' && url.pathname==='/visitor-count') {
        const base = await baseline(env.DB);
        if (base===null) return response(request,{ok:false,error:'Counter baseline is not configured'},503);
        const row = await env.DB.prepare("SELECT value FROM settings WHERE key='new_sessions'").first();
        return response(request,{count:base+Number(row?.value || 0),source:'cloudflare',metric:'Shopify baseline plus new tracked sessions'});
      }
      if (request.method==='GET' && url.pathname==='/activity') return response(request,await activity(env.DB,now));
      if (request.method==='GET' && url.pathname==='/recent') {
        const d = await activity(env.DB,now); return response(request,{events:d.purchases});
      }
      if (request.method==='POST' && ['/shopify/order-paid','/webhooks/shopify/orders-paid'].includes(url.pathname)) return await webhook(request,env,now);
      if (request.method!=='POST') return response(request,{ok:false,error:'Not found'},404);
      // Storefront writes require a browser Origin. Signed Shopify webhooks are handled above.
      if (!ORIGINS.has(origin)) return response(request,{ok:false,error:'Storefront origin required'},403);
      if (request.headers.get('x-sm-owner')==='1') return response(request,{ignored:true});
      const input = JSON.parse(new TextDecoder().decode(await body(request)) || '{}');
      if (url.pathname==='/visit') return await visit(request,env,input,now);
      if (['/heartbeat','/leave','/view','/cart'].includes(url.pathname)) {
        const token = text(input.session_id,128);
        if (!/^[a-f0-9]{64}$/.test(token)) return response(request,{ok:false,error:'Invalid session'},400);
        const updates = url.pathname==='/view' ? ['current_view=?',text(input.current_view,100)||'Store'] : url.pathname==='/cart' ? ['state=?',Number(input.item_count)>0?'cart':'active'] : null;
        const sql = 'UPDATE sessions SET last_seen=?,departed=?'+(updates?','+updates[0]:'')+' WHERE token=? AND created_at>?';
        const args = [now,url.pathname==='/leave'?1:0,...(updates?[updates[1]]:[]),token,now-DAY];
        const result = await env.DB.prepare(sql).bind(...args).run();
        return response(request,{ok:result.meta.changes>0});
      }
      return response(request,{ok:false,error:'Not found'},404);
    } catch (error) {
      return response(request,{ok:false,error:error.status===413?'Payload too large':error instanceof SyntaxError?'Invalid JSON':'Service not ready'},error.status || (error instanceof SyntaxError?400:503));
    }
  }
};
