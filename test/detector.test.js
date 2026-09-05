const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  DutyDetector,
  inferDutyTarget,
  normalizeTabletDutyAction,
  OBSERVER_SOURCE,
  wireDetector,
  sleep,
} = require('../src/core/detector');

test('script injetado no tablet compila e contém o listener de ação', () => {
  assert.doesNotThrow(() => new Function(OBSERVER_SOURCE));
  assert.match(OBSERVER_SOURCE, /duty-action/);
  assert.match(OBSERVER_SOURCE, /sair.*servi\[cç\]o/i);
});

test('processo principal rejeita evento amplo deixado por listener antigo', () => {
  assert.equal(normalizeTabletDutyAction({
    action: 'enter',
    target: 'on-duty',
    text: 'Início Ocorrências Cidadãos Fora de Serviço ENTRAR EM SERVIÇO',
  }), null);
  assert.deepEqual(normalizeTabletDutyAction({
    action: 'exit',
    target: 'off-duty',
    text: '  ENTRAR\nEM SERVIÇO ',
  }), {
    action: 'enter',
    target: 'on-duty',
    text: 'ENTRAR EM SERVIÇO',
  });
  assert.deepEqual(normalizeTabletDutyAction({ text: 'SAIR DE SERVIÇO' }), {
    action: 'exit',
    target: 'off-duty',
    text: 'SAIR DE SERVIÇO',
  });
});

test('nova versão do observer reinstala mesmo quando o marcador legado permanece no FiveM', () => {
  const listeners = new Map();
  const document = {
    documentElement: {},
    querySelectorAll: () => [],
    addEventListener: (type, listener) => listeners.set(type, listener),
  };
  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }
  const window = {
    __mtpAutoTimesheetInstalled: true,
    mtpAutoTimesheetOnStatus: () => {},
  };
  const runObserver = new Function('window', 'document', 'MutationObserver', 'location', OBSERVER_SOURCE);
  assert.equal(runObserver(window, document, FakeMutationObserver, { href: 'tablet' }), undefined);
  assert.equal(typeof listeners.get('click'), 'function');
  assert.equal(window.__mtpAutoTimesheetInstalled, '1.1.5');
});

function installFakeTabletObserver() {
  const listeners = new Map();
  const payloads = [];
  const document = {
    documentElement: {},
    querySelectorAll: () => [],
    addEventListener: (type, listener) => listeners.set(type, listener),
  };
  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }
  const window = {
    mtpAutoTimesheetOnStatus: (payload) => payloads.push(JSON.parse(payload)),
  };
  const runObserver = new Function('window', 'document', 'MutationObserver', 'location', OBSERVER_SOURCE);
  runObserver(window, document, FakeMutationObserver, { href: 'https://cfx-nui-metro-police-tablet/' });
  return { click: listeners.get('click'), payloads };
}

function fakeNode(text) {
  return { innerText: text, textContent: text };
}

test('ignora clique no menu lateral mesmo quando a página contém Entrar em Serviço', () => {
  const { click, payloads } = installFakeTabletObserver();
  const menuItem = fakeNode('Ocorrências');
  const sidebar = fakeNode('Início Ocorrências Cidadãos Veículos');
  const page = fakeNode('Início Ocorrências Cidadãos Fora de Serviço Descansando ENTRAR EM SERVIÇO');

  click({ target: menuItem, composedPath: () => [menuItem, sidebar, page] });

  assert.deepEqual(payloads.filter((payload) => payload.kind === 'duty-action'), []);
});

test('captura somente o rótulo exato do botão Entrar em Serviço', () => {
  const { click, payloads } = installFakeTabletObserver();
  const label = fakeNode('  ENTRAR\nEM SERVIÇO  ');
  const page = fakeNode('Fora de Serviço Descansando ENTRAR EM SERVIÇO');

  click({ target: label, composedPath: () => [label, page] });

  assert.deepEqual(payloads.filter((payload) => payload.kind === 'duty-action'), [{
    kind: 'duty-action',
    action: 'enter',
    target: 'on-duty',
    text: 'ENTRAR EM SERVIÇO',
    frame: 'https://cfx-nui-metro-police-tablet/',
  }]);
});

test('captura somente o rótulo exato do botão Sair de Serviço', () => {
  const { click, payloads } = installFakeTabletObserver();
  const label = fakeNode('SAIR DE SERVIÇO');
  const page = fakeNode('Em Serviço Trabalhando SAIR DE SERVIÇO');

  click({ target: label, composedPath: () => [label, page] });

  assert.deepEqual(payloads.filter((payload) => payload.kind === 'duty-action'), [{
    kind: 'duty-action',
    action: 'exit',
    target: 'off-duty',
    text: 'SAIR DE SERVIÇO',
    frame: 'https://cfx-nui-metro-police-tablet/',
  }]);
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
