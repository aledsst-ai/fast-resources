const test = require('node:test');
const assert = require('node:assert/strict');
const { FastDashboard } = require('../src/fast-dashboard');

test('gera um token individual e envia versão e estado de serviço ao domínio FAST', async () => {
  let saved = '';
  let onDuty = false;
  const calls = [];
  const client = new FastDashboard({ version: '1.1.10', loadToken: () => saved, saveToken: t => { saved = t; },
    getOnDuty: () => onDuty,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ code: 'ABCDEFGH' }) }; } });
  assert.equal(await client.heartbeat(), false);
  await client.pair();
  assert.match(saved, /^fast_app_[a-f0-9]{64}$/);
  const token = saved;
  await client.pair();
  assert.equal(saved, token);
  assert.equal(await client.heartbeat(), true);
  assert.equal(calls[2].url, 'https://fastdivision.com.br/api/fast-app/heartbeat');
  assert.deepEqual(JSON.parse(calls[2].options.body), { appVersion: '1.1.10', onDuty: false });
  assert.equal(calls[2].options.headers.Authorization, 'Bearer ' + token);
  assert.equal(calls[2].options.redirect, 'error');
  onDuty = true;
  assert.equal(await client.heartbeat(), true);
  assert.deepEqual(JSON.parse(calls[3].options.body), { appVersion: '1.1.10', onDuty: true });
});

test('comunicações concorrentes preservam o estado de serviço mais recente', async () => {
  const calls = [];
  const finishes = [];
  const client = new FastDashboard({ version: '1.1.10', loadToken: () => 'token', saveToken: () => {},
    fetchImpl: (url, options) => {
      calls.push({ url, options });
      return new Promise(resolve => { finishes.push(resolve); });
    } });
  const first = client.heartbeat(false);
  assert.equal(await client.heartbeat(true), false);
  finishes[0]({ ok: true, json: async () => ({ paired: true }) });
  while (finishes.length < 2) await new Promise(resolve => setImmediate(resolve));
  finishes[1]({ ok: true, json: async () => ({ paired: true }) });
  assert.equal(await first, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].options.body), { appVersion: '1.1.10', onDuty: true });
  assert.equal(client.busy, false);
});

test('falhas de rede não interrompem o ponto', async () => {
  const client = new FastDashboard({ version: '1.1.10', loadToken: () => 'token', saveToken: () => {},
    fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(await client.heartbeat(true), false);
  assert.equal(client.busy, false);
});
