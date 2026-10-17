import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import worker from '../src/worker.mjs';

function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const db = {prepare(query) {
    let args=[];
    const statement = {bind(...v){args=v;return statement;},
      async first(){return sql.prepare(query).get(...args)||null;},
      async all(){return {results:sql.prepare(query).all(...args)};},
      async run(){return {meta:{changes:Number(sql.prepare(query).run(...args).changes)}}},
      async execute(){return sql.prepare(query).columns().length ? statement.all() : statement.run();}};
    return statement;
  }, async batch(statements) {
    sql.exec('BEGIN');
    try { const results=[]; for(const s of statements)results.push(await s.execute()); sql.exec('COMMIT'); return results; }
    catch(e){sql.exec('ROLLBACK');throw e;}
  }};
  return {db,sql};
}
function request(path,body,extra={}) {
  const req=new Request('https://example.workers.dev'+path,{method:body===undefined?'GET':'POST',headers:{origin:'https://style-mechanics.com','content-type':'application/json','cf-connecting-ip':'192.0.2.1','user-agent':'Mozilla/5.0',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
  Object.defineProperty(req,'cf',{value:{country:'US',region:'Florida',city:'Kissimmee',latitude:'28.29',longitude:'-81.4'}});
  return req;
}
function setup() {
  const {db,sql}=database();
  sql.prepare('INSERT INTO settings VALUES (?,?)').run('counter_baseline','16259');
  return {env:{DB:db,TRACKING_SECRET:'test-only-tracking-secret',SHOPIFY_WEBHOOK_SECRET:'test-only-webhook-secret'},sql};
}
test('health identifies missing binding; counter fails safely',async()=>{
  assert.equal((await (await worker.fetch(request('/health'),{})).json()).database,'not_bound');
  assert.equal((await worker.fetch(request('/visitor-count'),{})).status,503);
});
test('repeated visits share a session; total persists without exposing the token',async()=>{
  const {env,sql}=setup();
  const a=await (await worker.fetch(request('/visit',{}),env)).json();
  const b=await (await worker.fetch(request('/visit',{}),env)).json();
  assert.equal(a.session_id,b.session_id);
  assert.equal(sql.prepare('SELECT lifetime FROM locations').get().lifetime,1);
  assert.equal((await (await worker.fetch(request('/visitor-count'),env)).json()).count,16260);
  const data=await (await worker.fetch(request('/activity'),env)).json();
  assert.equal(data.active.length,1);assert.equal(data.heat[0].lifetime,1);
  assert.equal(data.heat[0].visits_7d,1);
  assert.equal(JSON.stringify(data).includes(a.session_id),false);
  assert.equal(JSON.stringify(data).includes('192.0.2.1'),false);
});
test('leave removes online presence; heartbeat resumes without incrementing',async()=>{
  const {env}=setup();
  const {session_id}=await (await worker.fetch(request('/visit',{}),env)).json();
  await worker.fetch(request('/leave',{session_id}),env);
  assert.equal((await (await worker.fetch(request('/activity'),env)).json()).active.length,0);
  await worker.fetch(request('/heartbeat',{session_id}),env);
  assert.equal((await (await worker.fetch(request('/activity'),env)).json()).active.length,1);
  assert.equal((await (await worker.fetch(request('/visitor-count'),env)).json()).count,16260);
});
test('unknown geolocation never produces a dot at zero',async()=>{
  const {env}=setup(); const r=request('/visit',{});
  Object.defineProperty(r.cf,'latitude',{value:null});Object.defineProperty(r.cf,'longitude',{value:null});
  await worker.fetch(r,env);
  const data=await (await worker.fetch(request('/activity'),env)).json();
  assert.equal(data.heat.length,0);assert.equal(data.routes[0].lat,null);
});
test('owner and known crawler requests do not increment',async()=>{
  const {env}=setup();
  await worker.fetch(request('/visit',{}, {'x-sm-owner':'1'}),env);
  await worker.fetch(request('/visit',{}, {'user-agent':'Googlebot'}),env);
  assert.equal((await (await worker.fetch(request('/visitor-count'),env)).json()).count,16259);
});
test('foreign and absent storefront origins cannot write',async()=>{
  const {env}=setup();
  assert.equal((await worker.fetch(request('/visit',{}, {origin:'https://example.com'}),env)).status,403);
  const noOrigin=request('/visit',{});noOrigin.headers.delete('origin');
  assert.equal((await worker.fetch(noOrigin,env)).status,403);
});
test('counter baseline is required; missing schema fails without fabricated totals',async()=>{
  const {env,sql}=setup();sql.exec('DELETE FROM settings');
  assert.equal((await worker.fetch(request('/visit',{}),env)).status,503);
  assert.equal((await worker.fetch(request('/visitor-count'),env)).status,503);
  sql.exec('DROP TABLE settings');
  assert.equal((await worker.fetch(request('/visitor-count'),env)).status,503);
});
test('paid webhook verifies raw-body HMAC and deduplicates; no customer details escape',async()=>{
  const {env}=setup();
  const order={id:123,email:'private@example.com',shipping_address:{city:'Kissimmee',province:'Florida',country_code:'US',address1:'Private street'}};
  const signature=createHmac('sha256',env.SHOPIFY_WEBHOOK_SECRET).update(JSON.stringify(order)).digest('base64');
  const headers={'x-shopify-topic':'orders/paid','x-shopify-hmac-sha256':signature};
  assert.equal((await worker.fetch(request('/webhooks/shopify/orders-paid',order),env)).status,401);
  assert.equal((await (await worker.fetch(request('/webhooks/shopify/orders-paid',order,headers),env)).json()).duplicate,false);
  assert.equal((await (await worker.fetch(request('/webhooks/shopify/orders-paid',order,headers),env)).json()).duplicate,true);
  const data=await (await worker.fetch(request('/activity'),env)).json();
  assert.equal(data.purchases.length,1);
  assert.equal(JSON.stringify(data).includes('Private street'),false);
  assert.equal(JSON.stringify(data).includes('private@example.com'),false);
  assert.equal(data.purchases[0].location.lat,null);
});
