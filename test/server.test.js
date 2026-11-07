import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createAppServer, verifyShopifyHmac, sanitizeShopifyOrder } from '../server.js';

test('Shopify signature verifies exact raw bytes and rejects tampering', () => {
  const raw = Buffer.from('{"id":123}');
  const secret = 'test-only-secret';
  const hmac = createHmac('sha256', secret).update(raw).digest('base64');
  assert.equal(verifyShopifyHmac(raw, hmac, secret), true);
  assert.equal(verifyShopifyHmac(Buffer.from('{"id":124}'), hmac, secret), false);
  assert.equal(verifyShopifyHmac(raw, hmac, ''), false);
});

test('public purchase event excludes customer PII', () => {
  const event = sanitizeShopifyOrder({
    id: 123,
    email: 'private@example.com',
    customer: { first_name: 'Private' },
    shipping_address: { city: 'New York', province_code: 'NY', country_code: 'US', address1: '123 Private St', phone: '5551234' }
  });
  assert.equal(event.city, 'New York');
  assert.equal(event.region, 'NY');
  assert.equal(event.country, 'US');
  assert.equal(event.orderId, '123');
  assert.doesNotMatch(JSON.stringify(event), /private@example|Private St|5551234|first_name/);
});

test('health, CORS and unauthenticated purchase behavior', async (t) => {
  const server = createAppServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const health = await fetch(base + '/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const blocked = await fetch(base + '/purchase', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(blocked.status, 401);
  const origin = await fetch(base + '/health', { headers: { origin: 'https://not-allowed.example' } });
  assert.equal(origin.headers.get('access-control-allow-origin'), null);
  const allowed = await fetch(base + '/health', { headers: { origin: 'https://style-mechanics.com' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://style-mechanics.com');
});
