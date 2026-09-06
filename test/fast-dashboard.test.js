const test = require('node:test');
const assert = require('node:assert/strict');
const { FastDashboard } = require('../src/fast-dashboard');

test('gera um token individual e envia somente a versão ao domínio FAST', async () => {
  let saved = '';
  const calls = [];
  const client = new FastDashboard({ version: '1.1.9', loadToken: () => saved, saveToken: t => { saved = t; },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ code: 'ABCDEFGH' }) }; } });
  assert.equal(await client.heartbeat(), false);
  await client.pair();
  assert.match(saved, /^fast_app_[a-f0-9]{64}$/);
  const token = saved;
  await client.pair();
  assert.equal(saved, token);
  assert.equal(await client.heartbeat(), true);
  assert.equal(calls[2].url, 'https://fastdivision.com.br/api/fast-app/heartbeat');
  assert.deepEqual(JSON.parse(calls[2].options.body), { appVersion: '1.1.9' });
  assert.equal(calls[2].options.headers.Authorization, 'Bearer ' + token);
  assert.equal(calls[2].options.redirect, 'error');
});

test('falhas de rede não interrompem o ponto e comunicações concorrentes são agrupadas', async () => {
  let finish;
  const client = new FastDashboard({ version: '1.1.9', loadToken: () => 'token', saveToken: () => {},
    fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
  const first = client.heartbeat();
  assert.equal(await client.heartbeat(), false);
  finish({ ok: false, status: 503 });
  assert.equal(await first, false);
  assert.equal(client.busy, false);
});
