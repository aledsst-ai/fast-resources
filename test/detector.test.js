const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  DutyDetector,
  inferDutyTarget,
  OBSERVER_SOURCE,
  wireDetector,
  sleep,
} = require('../src/core/detector');

test('script injetado no tablet compila e contém o listener de ação', () => {
  assert.doesNotThrow(() => new Function(OBSERVER_SOURCE));
  assert.match(OBSERVER_SOURCE, /duty-action/);
  assert.match(OBSERVER_SOURCE, /sair.*servi\[cç\]o/i);
});

test('mantém o token da gameapi e ignora tokens do phoneapi', () => {
  const detector = new DutyDetector();
  const gameToken = 'Bearer eyJgame.payload.signature';
  const phoneToken = 'Bearer eyJphone.payload.signature';

  assert.equal(detector._captureTokenFromHeaders(
    { Authorization: gameToken },
    'https://api.metropole.gg/gameapi-01/tablet/dashboard',
  ), true);
  assert.equal(detector._bearerToken, gameToken);

  assert.equal(detector._captureTokenFromHeaders(
    { Authorization: phoneToken },
    'https://api.metropole.gg/phoneapi/contact/all',
  ), false);
  assert.equal(detector._bearerToken, gameToken);
});

test('reconhece ações de serviço em URL e corpo de requisição', () => {
  assert.equal(inferDutyTarget({
    url: 'https://api.metropole.gg/gameapi-01/police/duty',
    postData: '{"action":"exit"}',
  }), 'off-duty');
  assert.equal(inferDutyTarget({
    url: 'https://api.metropole.gg/gameapi-01/tablet/service/enter',
  }), 'on-duty');
  assert.equal(inferDutyTarget({
    url: 'https://api.metropole.gg/phoneapi/contact/all',
  }), null);
});

test('não perde saída detectada enquanto o Discord ainda abre o ponto', async () => {
  const detector = new EventEmitter();
  const calls = [];
  let releaseOpen;
  const opening = new Promise((resolve) => { releaseOpen = resolve; });

  const ctl = wireDetector(detector, async (button) => {
    calls.push(button);
    if (button === 'Abrir Ponto') await opening;
    return true;
  });

  detector.emit('status', { status: 'on-duty', text: 'Em Serviço', source: 'test' });
  while (calls.length === 0) await sleep(1);
  detector.emit('status', { status: 'off-duty', text: 'Fora de Serviço', source: 'tablet-click:test' });
  releaseOpen();

  await ctl.whenIdle();
  assert.deepEqual(calls, ['Abrir Ponto', 'Fechar Ponto']);
  assert.equal(ctl.pontoOpen, false);
  assert.equal(ctl.desiredOpen, false);
});

test('estado repetido não provoca clique duplicado no Discord', async () => {
  const detector = new EventEmitter();
  const calls = [];
  const ctl = wireDetector(detector, async (button) => { calls.push(button); });

  detector.emit('status', { status: 'on-duty', text: 'Em Serviço', source: 'observer' });
  await ctl.whenIdle();
  detector.emit('status', { status: 'on-duty', text: 'Em Serviço', source: 'api' });
  await ctl.whenIdle();

  assert.deepEqual(calls, ['Abrir Ponto']);
});
