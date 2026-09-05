// Núcleo do monitor: detecta entrada/saída de serviço no FiveM via CDP na NUI.
// Não depende de Electron nem de navegador — dá pra testar com node puro.
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { log } = require('./logger');
const { installOverlay, pushOverlay } = require('./nui-overlay');
const { installPhoneNotify, installPhoneNotifyContext, pushPhoneNotify, buildPayload, overridePhoneIcon, playPhoneSound, POLICE_ICON_URL, POLICE_SOUND_URL } = require('./phone-notify');

const NUI_URL = process.env.MTP_AUTO_TIMESHEET_NUI_URL || 'http://localhost:13172/';
const HEARTBEAT_MS = 5_000;         // pinga /json/list pra confirmar NUI viva
const NO_CONN_CONFIRM_TICKS = 3;    // 3 heartbeats falhados (~15s) = desconectou
const REATTACH_DELAY_MS = 2_000;
const POLL_INTERVAL_MS = 5_000;     // poll da API character/data
const WAIT_FIVEM_POLL_MS = 3_000;   // intervalo de sondagem enquanto o FiveM não abre
const WAIT_LOG_EVERY = 20;          // loga "aguardando" a cada N sondagens (~1min)
const CLOSE_RETRY_ATTEMPTS = 5;     // tentativas de fechar o ponto quando o FiveM cai
const CLOSE_RETRY_DELAY_MS = 10_000;
const FAST_POLL_DELAYS_MS = [250, 750, 1_500, 3_000];
const RECONCILE_RETRY_ATTEMPTS = 3;
const RECONCILE_RETRY_DELAY_MS = 3_000;

const CHARACTER_DATA_URL = 'https://api.metropole.gg/gameapi-01/character/data';

const BINDING_NAME = 'mtpAutoTimesheetOnStatus';
const ISOLATED_WORLD_NAME = 'mtpAutoTimesheetWorld';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------- CDP session (EventEmitter) --------

class CdpSession extends EventEmitter {
  constructor(wsUrl) {
    super();
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const t = setTimeout(() => { try { ws.terminate(); } catch {} reject(new Error('CDP connect timeout')); }, 5000);
      ws.on('open', () => { clearTimeout(t); this.ws = ws; resolve(); });
      ws.on('error', (err) => { clearTimeout(t); reject(err); });
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.id != null) {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        } else if (msg.method) {
          // Eventos: se vierem de sessão filha (flatten), incluem sessionId
          const params = msg.params || {};
          if (msg.sessionId) params.__sessionId = msg.sessionId;
          this.emit(msg.method, params);
        }
      });
      ws.on('close', () => this._teardown());
    });
  }
  send(method, params = {}, sessionId = null) {
    return new Promise((resolve, reject) => {
      if (this.closed || !this.ws) return reject(new Error('CDP session not open'));
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout em ${method}`)); }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }
  // Sempre emite '__closed__' — o loop de reattach depende disso pra acordar,
  // tanto num close explícito quanto numa queda do socket.
  _teardown() {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('CDP session closed')); }
    this.pending.clear();
    this.emit('__closed__');
  }
  close() {
    try { this.ws && this.ws.close(); } catch {}
    this._teardown();
  }
}

async function fetchTargets() {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${NUI_URL}json/list`, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function flattenFrames(node, acc = []) {
  acc.push(node.frame);
  for (const child of node.childFrames || []) flattenFrames(child, acc);
  return acc;
}

function inferDutyTarget(request = {}) {
  const url = String(request.url || '');
  const body = String(request.postData || '');
  if (!/api\.metropole\.gg\/gameapi-01\//i.test(url)) return null;
  const relevant = /(?:duty|servi[cç]o|police|tablet)/i.test(`${url} ${body}`)
    || /["']action["']\s*:\s*["'](?:enter|exit)["']/i.test(body);
  if (!relevant) return null;
  if (/(?:^|[^a-z])(?:exit|off[ -]?duty|sair)(?:[^a-z]|$)/i.test(body)
      || /(?:exit|off[ -]?duty|sair)/i.test(url)) return 'off-duty';
  if (/(?:^|[^a-z])(?:enter|on[ -]?duty|entrar)(?:[^a-z]|$)/i.test(body)
      || /(?:enter|on[ -]?duty|entrar)/i.test(url)) return 'on-duty';
  return null;
}

// -------- Observer script injetado no metro-inventory --------

const OBSERVER_SOURCE = `
(function(){
  if (window.__mtpAutoTimesheetInstalled) return 'already';
  window.__mtpAutoTimesheetInstalled = true;

  var lastText = null;
  var lastActionAt = 0;
  var send = function(payload){
    try { window.${BINDING_NAME}(JSON.stringify(payload)); } catch(e) {}
  };
  var clean = function(value){
    return String(value || '').replace(/\\s+/g, ' ').trim();
  };
  var actionFromText = function(text){
    var value = clean(text);
    if (/sair(?:[ ]+de)?[ ]+servi[cç]o/i.test(value)) {
      return { action: 'exit', target: 'off-duty', text: value };
    }
    if (/entrar(?:[ ]+em)?[ ]+servi[cç]o/i.test(value)) {
      return { action: 'enter', target: 'on-duty', text: value };
    }
    return null;
  };
  var findSpan = function(){
    var spans = document.querySelectorAll('span');
    for (var i = 0; i < spans.length; i++) {
      var t = spans[i].textContent || '';
      if (/(?:Pol[ií]cia(?:[ ]+Militar)?(?:[ ]+do)?[ ]+Norte|North[ ]+Police)/i.test(t)) return spans[i];
    }
    return null;
  };
  var trackedSpan = null;
  var innerObs = new MutationObserver(function(){ checkAndDispatch(true); });
  function checkAndDispatch(fromInner){
    var s = findSpan();
    var text = s ? (s.textContent || '') : '';
    if (text !== lastText) {
      lastText = text;
      send({ kind: 'status', text: text, frame: location.href });
    }
    if (!fromInner && s !== trackedSpan) {
      innerObs.disconnect();
      trackedSpan = s;
      if (s) innerObs.observe(s, { characterData: true, childList: true, subtree: true });
    }
  }
  var rootObs = new MutationObserver(function(){ checkAndDispatch(false); });
  rootObs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // O tablet costuma fechar no mesmo clique que troca o serviço. Capturamos a
  // intenção na fase capture, antes de o DOM desaparecer, e depois confirmamos
  // pela API/observer. O listener cobre clique por mouse e ativação por teclado.
  document.addEventListener('click', function(event){
    var path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (!path.length && event.target) path = [event.target];
    for (var i = 0; i < path.length && i < 8; i++) {
      var node = path[i];
      if (!node || typeof node.textContent !== 'string') continue;
      var action = actionFromText(node.innerText || node.textContent);
      if (!action) continue;
      var now = Date.now();
      if (now - lastActionAt < 1_000) return;
      lastActionAt = now;
      send({
        kind: 'duty-action',
        action: action.action,
        target: action.target,
        text: action.text,
        frame: location.href
      });
      return;
    }
  }, true);

  checkAndDispatch(false);
  return 'installed';
})()
`;

// -------- DutyDetector event-driven --------

class DutyDetector extends EventEmitter {
  // events: 'status' ({status, text, source}), 'no-connection', 'attached', 'reconnected', 'stopped'
  constructor() {
    super();
    this.session = null;              // sempre conectada no ROOT
    this.stopped = false;
    this.attached = false;
    this.observerInstalled = false;   // observer no metro-inventory (quando o iframe existe)
    this._lastEmittedStatus = null;   // dedup unificado (observer + poll)
    this._probeFailures = 0;
    this._connectedOnce = false;      // já anexou alguma vez? (separa espera de queda)
    this._disconnectAnnounced = false;// 'no-connection' é edge-triggered, 1x por queda
    this._heartbeatTimer = null;
    this._pollTimer = null;
    this._polling = false;
    this._bearerToken = null;         // JWT extraído de localStorage/sessionStorage
    this._requestUrlById = new Map(); // correlaciona ExtraInfo com a URL original
    this._pendingDutyRequests = new Map();
    this._fastPollTimers = new Set();
    this._lastTabletAction = null;
    this._lastPollError = null;
    this._overlayCtx = null;          // contexto isolado do overlay na raiz da NUI
    this._rootFrameId = null;
  }

  // Notificação NATIVA no celular do jogo, via SignalR (injeta um frame "Notify"
  // no hub phoneapi já aberto). Caminho primário do aviso in-game: parece uma
  // notificação de verdade do celular, com som próprio. Retorna false se nenhum
  // socket foi capturado ainda (ex.: logo após anexar) — aí quem chama cai no overlay.
  async notifyPhone(title, body, appId, sound = true) {
    if (!this.session || !this.attached) return false;
    const ctxIds = Array.from(this._mainContextByFrame.values());
    if (!ctxIds.length) return false;
    // Idempotente: cobre contextos que já existiam antes do listener.
    await installPhoneNotify(this.session, ctxIds).catch(() => {});
    const ok = await pushPhoneNotify(this.session, ctxIds, buildPayload({ title, body, appId })).catch(() => false);
    if (ok) {
      // Troca o ícone do banco pelo da FAST - North Police só nesta notificação.
      await overridePhoneIcon(this.session, ctxIds, title, POLICE_ICON_URL).catch(() => {});
      // O card do celular não toca som sozinho — tocamos o som da polícia.
      if (sound) await playPhoneSound(this.session, ctxIds, POLICE_SOUND_URL).catch(() => {});
    }
    return ok;
  }

  // Avisa o jogador DENTRO do jogo. Em fullscreen exclusive é o único jeito:
  // janela do Windows não aparece por cima do jogo nesse modo.
  // Retorna false se não der (sem FiveM, contexto morto) — aí o main cai na janela.
  async notifyInGame(title, body, type = 'info', sound = true) {
    if (!this.session || !this.attached) return false;
    try {
      if (!this._overlayCtx) await this._installOverlay();
      if (!this._overlayCtx) return false;
      return await pushOverlay(this.session, this._overlayCtx, { title, body, type, sound });
    } catch (err) {
      // Contexto pode ter morrido numa navegação: tenta reinstalar uma vez.
      this._overlayCtx = null;
      try {
        await this._installOverlay();
        if (!this._overlayCtx) return false;
        return await pushOverlay(this.session, this._overlayCtx, { title, body, type, sound });
      } catch (err2) {
        log(`Overlay na NUI falhou: ${err2.message}`);
        return false;
      }
    }
  }

  async _installOverlay() {
    if (!this.session || !this._rootFrameId) return false;
    try {
      this._overlayCtx = await installOverlay(this.session, this._rootFrameId);
      return true;
    } catch (err) {
      this._overlayCtx = null;
      log(`Não consegui instalar o overlay na NUI: ${err.message}`);
      return false;
    }
  }

  // Roda até stop() ser chamado explicitamente. Nunca desiste sozinho:
  // se o FiveM não está aberto, apenas segue sondando a rota até ele aparecer.
  async start() {
    while (!this.stopped) {
      const ok = await this._tryAttach();
      if (!ok) {
        this._onProbeFail();
        await sleep(this._connectedOnce ? REATTACH_DELAY_MS : WAIT_FIVEM_POLL_MS);
        continue;
      }
      this._startHeartbeat();
      this._startPolling();
      const session = this.session;
      if (!session.closed) await new Promise((resolve) => session.once('__closed__', resolve));
      log('Sessão CDP encerrada.');
      this._stopHeartbeat();
      this._stopPolling();
      this.attached = false;
      this.observerInstalled = false;
      this.session = null;
      if (this.stopped) break;
      await sleep(REATTACH_DELAY_MS);
    }
    this.emit('stopped');
  }

  stop() {
    this.stopped = true;
    this._stopHeartbeat();
    this._stopPolling();
    for (const timer of this._fastPollTimers) clearTimeout(timer);
    this._fastPollTimers.clear();
    if (this.session) this.session.close();
  }

  _dispatch(status, text, source) {
    if (status === this._lastEmittedStatus) return;
    this._lastEmittedStatus = status;
    this.emit('status', { status, text: text || '', source });
  }

  _handleTabletAction(payload) {
    const now = Date.now();
    if (this._lastTabletAction
        && this._lastTabletAction.target === payload.target
        && now - this._lastTabletAction.at < 1_500) return;
    this._lastTabletAction = { target: payload.target, at: now };
    const frame = /police-tablet/i.test(payload.frame || '') ? 'police-tablet' : 'nui';
    log(`Clique do tablet capturado antes do fechamento: ${payload.action} -> ${payload.target}.`);

    // A intenção do próprio botão é o sinal mais rápido. Se o servidor rejeitar
    // a ação, os polls logo abaixo corrigem o estado assim que a API responder.
    this._dispatch(payload.target, payload.text || payload.action, `tablet-click:${frame}`);
    for (const delay of FAST_POLL_DELAYS_MS) {
      const timer = setTimeout(() => {
        this._fastPollTimers.delete(timer);
        this._pollOnce(`confirmação +${delay}ms`).catch(() => {});
      }, delay);
      this._fastPollTimers.add(timer);
    }
  }

  async _tryAttach() {
    const targets = await fetchTargets();
    if (!targets) return false;
    const root = targets.find((t) => t.title === 'CitizenFX root UI');
    if (!root) return false;

    const session = new CdpSession(root.webSocketDebuggerUrl);
    try {
      await session.connect();

      // Registra listeners ANTES de habilitar domínios (senão perdemos os eventos iniciais)
      this._mainContextByFrame = new Map();
      session.on('Runtime.executionContextCreated', (ev) => {
        const ctx = ev.context || {};
        const aux = ctx.auxData || {};
        if (aux.isDefault && aux.frameId) {
          this._mainContextByFrame.set(aux.frameId, ctx.id);
          // Instala o capturador do socket SignalR do celular já na criação do
          // contexto, pra os pings serem pegos com antecedência (o socket leva
          // ~15s pra pingar). Idempotente e silencioso.
          installPhoneNotifyContext(session, ctx.id).catch(() => {});
        }
      });
      session.on('Runtime.executionContextDestroyed', (ev) => {
        for (const [fid, cid] of this._mainContextByFrame) {
          if (cid === ev.executionContextId) { this._mainContextByFrame.delete(fid); break; }
        }
        // Se o mundo do overlay morreu, marca pra reinstalar no próximo aviso.
        if (this._overlayCtx === ev.executionContextId) this._overlayCtx = null;
      });

      session.on('Runtime.bindingCalled', (ev) => {
        if (ev.name !== BINDING_NAME) return;
        let payload;
        try { payload = JSON.parse(ev.payload); } catch { return; }
        if (payload.kind === 'duty-action' && /^(?:on|off)-duty$/.test(payload.target || '')) {
          this._handleTabletAction(payload);
          return;
        }
        const text = payload.text || '';
        const status = !text ? 'unknown'
          : /fora de servi/i.test(text) ? 'off-duty'
          : 'on-duty';
        const frame = /police-tablet/i.test(payload.frame || '') ? 'police-tablet' : 'inventory';
        this._dispatch(status, text, `observer:${frame}`);
      });

      // Frame navegou/foi anexado → tenta (re)injetar observer no metro-inventory se aparecer
      const maybeInject = async () => { await this._tryInjectObservers(session).catch(() => {}); };
      session.on('Page.frameNavigated', maybeInject);
      session.on('Page.frameAttached', maybeInject);

      // Captura o Bearer token diretamente dos requests que o tablet faz à API.
      // É à prova de login: sempre pega o token atual que o jogo está usando,
      // sem depender de onde ele foi guardado (localStorage vs. memória).
      session.on('Network.requestWillBeSent', (ev) => {
        const request = ev.request || {};
        if (ev.requestId && request.url) {
          this._requestUrlById.set(ev.requestId, request.url);
          if (this._requestUrlById.size > 500) {
            this._requestUrlById.delete(this._requestUrlById.keys().next().value);
          }
        }
        this._captureTokenFromHeaders(request.headers, request.url);
        const target = inferDutyTarget(request);
        if (target && ev.requestId) {
          this._pendingDutyRequests.set(ev.requestId, { target, url: request.url || '' });
          log(`Ação de serviço observada na rede: ${target}. Aguardando resposta.`);
        }
      });
      session.on('Network.requestWillBeSentExtraInfo', (ev) => {
        this._captureTokenFromHeaders(ev.headers, this._requestUrlById.get(ev.requestId));
      });
      session.on('Network.responseReceived', (ev) => {
        const pending = this._pendingDutyRequests.get(ev.requestId);
        if (!pending) return;
        this._pendingDutyRequests.delete(ev.requestId);
        const response = ev.response || {};
        if (response.status >= 200 && response.status < 300) {
          const pathname = (() => { try { return new URL(pending.url).pathname; } catch { return pending.url; } })();
          this._dispatch(pending.target, `resposta ${response.status} em ${pathname}`, 'network:duty-action');
        } else {
          log(`Ação de serviço respondeu HTTP ${response.status || 'desconhecido'}; aguardando confirmação visual/API.`);
        }
      });

      // Agora habilita os domínios (listeners já estão registrados)
      await session.send('Runtime.enable');
      await session.send('Page.enable');
      await session.send('Network.enable');
      await session.send('Runtime.addBinding', { name: BINDING_NAME });

      // Primeira tentativa de injeção (se inventário já estiver aberto)
      await this._tryInjectObservers(session);

      // Guarda o frame raiz e instala o overlay de avisos nele.
      this.session = session;
      try {
        const { frameTree } = await session.send('Page.getFrameTree');
        this._rootFrameId = frameTree.frame.id;
        this._overlayCtx = null;
        await this._installOverlay();
      } catch (err) {
        log(`Não achei o frame raiz pro overlay: ${err.message}`);
      }

      // Tenta obter o Bearer token de imediato pra já poder pollar a API
      this.session = session;
      await this._refreshToken().catch(() => {});
      if (!this._bearerToken) {
        log('Token ainda não encontrado nos frames metro-* — vou tentar de novo a cada poll.');
      }

      this.attached = true;
      if (this._connectedOnce && this._probeFailures > 0) {
        log(`Reconectado após ${this._probeFailures} falhas.`);
        this.emit('reconnected');
      }
      this._connectedOnce = true;
      this._disconnectAnnounced = false;
      this._probeFailures = 0;
      log(`Detector conectado ao root. Observer=${this.observerInstalled ? 'ativo' : 'aguardando iframe'}. Poll API ativo (${POLL_INTERVAL_MS}ms).`);
      this.emit('attached');
      return true;
    } catch (err) {
      log(`Falha ao anexar detector: ${err.message}`);
      session.close();
      return false;
    }
  }

  // Mantém somente tokens da gameapi. A versão distribuída aceitava também os
  // tokens de phoneapi e acabava substituindo um token válido por outro que não
  // tinha acesso a character/data, inutilizando o fallback de confirmação.
  _captureTokenFromHeaders(headers, url) {
    if (!headers || !url || !/api\.metropole\.gg\/gameapi-01\//i.test(url)) return false;
    let auth = null;
    for (const k in headers) {
      if (k.toLowerCase() === 'authorization') { auth = headers[k]; break; }
    }
    if (!auth || !/(^|\s)eyJ[A-Za-z0-9_-]+\./.test(auth)) return false;
    const bearer = /^Bearer\s/i.test(auth) ? auth : `Bearer ${auth}`;
    if (bearer === this._bearerToken) return true;
    const wasEmpty = !this._bearerToken;
    this._bearerToken = bearer;
    const where = (() => { try { return new URL(url).pathname; } catch { return url; } })();
    log(`Token capturado via ${where}.${wasEmpty ? ' Poll API ativo.' : ' (rotacionado após login)'}`);
    return true;
  }

  // Fallback: procura um JWT (padrão eyJ...) em localStorage/sessionStorage de todos os frames metro-*.
  async _refreshToken() {
    if (!this.session) return null;
    let frameTree;
    try { ({ frameTree } = await this.session.send('Page.getFrameTree')); }
    catch { return null; }
    const frames = flattenFrames(frameTree).filter(
      (f) => /metro-/i.test(f.url || '') || /metro-/i.test(f.name || '')
    );

    const finder = `(function(){
      var out = [];
      function scan(store, prefix){
        try {
          for (var i = 0; i < store.length; i++) {
            var k = store.key(i);
            var v = store.getItem(k) || '';
            if (/^eyJ[a-zA-Z0-9_\\-]+\\./.test(v)) out.push({loc: prefix + ':' + k, v: v});
            // token pode estar dentro de um JSON serializado
            var m = v.match(/eyJ[a-zA-Z0-9_\\-]+\\.[a-zA-Z0-9_\\-]+\\.[a-zA-Z0-9_\\-]+/);
            if (m) out.push({loc: prefix + ':' + k + '(embedded)', v: m[0]});
          }
        } catch(e){}
      }
      try { scan(localStorage, 'ls'); } catch(e){}
      try { scan(sessionStorage, 'ss'); } catch(e){}
      // dedup
      var seen = {};
      out = out.filter(function(o){ if (seen[o.v]) return false; seen[o.v] = true; return true; });
      return JSON.stringify(out);
    })()`;

    for (const frame of frames) {
      try {
        const iso = await this.session.send('Page.createIsolatedWorld', {
          frameId: frame.id, worldName: 'mtpAutoTimesheetTokenScan', grantUniveralAccess: true,
        });
        const res = await this.session.send('Runtime.evaluate', {
          expression: finder, contextId: iso.executionContextId, returnByValue: true,
        });
        const raw = res && res.result && res.result.value;
        if (!raw) continue;
        const list = JSON.parse(raw);
        if (!list.length) continue;
        // Escolhe o primeiro JWT válido
        const jwt = list[0].v;
        const bearer = `Bearer ${jwt}`;
        if (bearer !== this._bearerToken) {
          const wasEmpty = !this._bearerToken;
          this._bearerToken = bearer;
          log(`Token capturado de ${frame.url} (${list[0].loc}).${wasEmpty ? ' Poll API ativo.' : ''}`);
        }
        return this._bearerToken;
      } catch {}
    }
    return null;
  }

  async _tryInjectObservers(session) {
    try {
      const { frameTree } = await session.send('Page.getFrameTree');
      const frames = flattenFrames(frameTree).filter(
        (f) => /metro-(?:inventory|police-tablet)/i.test(f.name || '')
          || /metro-(?:inventory|police-tablet)/i.test(f.url || '')
      );
      if (!frames.length) { this.observerInstalled = false; return false; }
      let installed = 0;
      const labels = [];
      for (const frame of frames) {
        try {
          const iso = await session.send('Page.createIsolatedWorld', {
            frameId: frame.id, worldName: ISOLATED_WORLD_NAME, grantUniveralAccess: true,
          });
          const res = await session.send('Runtime.evaluate', {
            expression: OBSERVER_SOURCE, contextId: iso.executionContextId, returnByValue: true,
          });
          const outcome = res && res.result && res.result.value;
          if (outcome === 'installed' || outcome === 'already') {
            installed += 1;
            labels.push(/police-tablet/i.test(`${frame.name} ${frame.url}`) ? 'police-tablet' : 'inventory');
          }
        } catch {}
      }
      const ok = installed > 0;
      if (ok && !this.observerInstalled) log(`Observers de serviço injetados: ${labels.join(', ')}.`);
      this.observerInstalled = ok;
      return ok;
    } catch (err) {
      this.observerInstalled = false;
      return false;
    }
  }

  _startPolling() {
    this._stopPolling();
    this._pollTimer = setInterval(() => { this._pollOnce().catch(() => {}); }, POLL_INTERVAL_MS);
  }

  _stopPolling() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  async _pollOnce(reason = 'periódico') {
    if (this._polling) return;
    this._polling = true;
    try {
      if (!this._bearerToken) {
        await this._refreshToken().catch(() => {});
        if (!this._bearerToken) return;
      }
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      let res;
      try {
        res = await fetch(CHARACTER_DATA_URL, {
          headers: { authorization: this._bearerToken, accept: 'application/json' },
          signal: controller.signal,
        });
      } finally { clearTimeout(t); }

      if (res.status === 401 || res.status === 403) {
        log(`Token da gameapi recusado (${res.status}, ${reason}). Invalidando cache; aguardando novo token.`);
        this._bearerToken = null;
        return;
      }
      if (!res.ok) {
        const marker = `${res.status}:${reason}`;
        if (marker !== this._lastPollError) log(`Consulta character/data respondeu HTTP ${res.status} (${reason}).`);
        this._lastPollError = marker;
        return;
      }
      this._lastPollError = null;

      const body = await res.json();
      const character = (body && body.data) ? body.data : body;
      const duty = character && character.duty;
      if (!duty || !duty.action) return; // sem duty (não é policia ou dado ausente)

      const action = String(duty.action).toLowerCase();
      const status = action === 'enter' ? 'on-duty'
                   : action === 'exit'  ? 'off-duty'
                   : 'unknown';
      if (status === 'unknown') return;
      this._dispatch(status, `duty.action=${duty.action}`, 'api:character/data');
    } catch (err) {
      if (reason !== 'periódico') log(`Falha na consulta rápida character/data (${reason}): ${err.message}`);
    } finally {
      this._polling = false;
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(async () => {
      const targets = await fetchTargets();
      const alive = !!(targets && targets.some((t) => t.title === 'CitizenFX root UI'));
      if (alive) {
        if (this._probeFailures > 0) log(`Heartbeat voltou. Zerando contador.`);
        this._probeFailures = 0;
      } else {
        this._onProbeFail();
      }
    }, HEARTBEAT_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
  }

  // Chamado tanto pelo heartbeat quanto por um attach falhado.
  // Antes do primeiro attach, isso NÃO é queda de conexão — é só o jogo ainda fechado.
  _onProbeFail() {
    this._probeFailures += 1;

    if (!this._connectedOnce) {
      if (this._probeFailures === 1 || this._probeFailures % WAIT_LOG_EVERY === 0) {
        log(`FiveM ainda não está em ${NUI_URL} — seguindo à espera (${this._probeFailures} sondagens).`);
      }
      return;
    }

    if (this._disconnectAnnounced) {
      if (this._probeFailures % WAIT_LOG_EVERY === 0) log('FiveM continua fora. Aguardando ele voltar...');
      return;
    }

    log(`Heartbeat NUI falhou (${this._probeFailures}/${NO_CONN_CONFIRM_TICKS}).`);
    if (this._probeFailures < NO_CONN_CONFIRM_TICKS) return;

    this._disconnectAnnounced = true;
    // O status vira desconhecido: ao reconectar queremos reagir de novo mesmo que
    // o jogo reporte o mesmo estado de antes da queda.
    this._lastEmittedStatus = null;
    // Derruba a sessão morta pra o loop do start() voltar a tentar anexar.
    if (this.session) this.session.close();
    this.emit('no-connection');
  }
}

// -------- Orquestração ponto <-> detector (testável) --------
// Liga os eventos do detector às ações de Abrir/Fechar Ponto no Discord.
// clickButton(texto) é injetável para permitir teste sem Discord de verdade.
// Retorna um EventEmitter que emite:
//   'ponto' ({open}) — a bandeja mostra o status e o main avisa o usuário
//   'erro'  ({action, message}) — clique falhou; quem escuta decide como avisar
function wireDetector(detector, clickButton) {
  const ctl = new EventEmitter();
  let pontoOpen = false;
  let desiredOpen = null;
  let desiredReason = '';
  let desiredAttempts = RECONCILE_RETRY_ATTEMPTS;
  let desiredDelay = RECONCILE_RETRY_DELAY_MS;
  let reconcilePromise = null;

  const setPonto = (open) => {
    if (pontoOpen === open) return;
    pontoOpen = open;
    ctl.emit('ponto', { open });
  };

  const reconcile = () => {
    if (reconcilePromise) return reconcilePromise;
    reconcilePromise = (async () => {
      let attempts = 0;
      while (desiredOpen !== null && desiredOpen !== pontoOpen) {
        const target = desiredOpen;
        const action = target ? 'abrir' : 'fechar';
        const button = target ? 'Abrir Ponto' : 'Fechar Ponto';
        const reason = desiredReason;
        try {
          await clickButton(button);
          setPonto(target);
          attempts = 0;
          log(target ? '>>> PONTO ABERTO <<<' : `>>> PONTO FECHADO (${reason}) <<<`);
          // O estado desejado pode ter mudado enquanto o Discord carregava. O
          // loop reconcilia imediatamente sem descartar essa segunda transição.
        } catch (e) {
          attempts += 1;
          log(`Falha ao ${action} ponto (${attempts}/${desiredAttempts}): ${e.message}`);
          if (attempts >= desiredAttempts) {
            ctl.emit('erro', { action, message: e.message });
            return false;
          }
          await sleep(desiredDelay);
        }
      }
      return desiredOpen === null || desiredOpen === pontoOpen;
    })().finally(() => { reconcilePromise = null; });
    return reconcilePromise;
  };

  const requestState = (open, reason, attempts = RECONCILE_RETRY_ATTEMPTS, delay = RECONCILE_RETRY_DELAY_MS) => {
    desiredOpen = open;
    desiredReason = reason;
    desiredAttempts = attempts;
    desiredDelay = delay;
    return reconcile();
  };

  const doOpen = () => requestState(true, 'entrou em serviço');
  const doClose = (reason) => requestState(false, reason || 'saiu de serviço');

  detector.on('status', ({ status, text, source }) => {
    log(`[status change via ${source}] ${status} — "${text}"`);
    if (status === 'on-duty') doOpen();
    else if (status === 'off-duty') doClose('saiu de serviço');
  });

  // FiveM perdido (você fechou o jogo). Se estiver em serviço, fecha o ponto
  // automaticamente. O monitor NUNCA encerra por isso: ele volta a sondar a rota
  // e reanexa sozinho quando o jogo abrir de novo.
  detector.on('no-connection', () => {
    log('Conexão com o FiveM perdida (sustentada). Sigo verificando até o jogo voltar.');
    requestState(false, 'FiveM fechado', CLOSE_RETRY_ATTEMPTS, CLOSE_RETRY_DELAY_MS);
  });

  detector.on('stopped', () => { log('Monitor encerrado.'); });

  Object.defineProperty(ctl, 'pontoOpen', { get: () => pontoOpen });
  Object.defineProperty(ctl, 'desiredOpen', { get: () => desiredOpen });
  ctl.doOpen = doOpen;
  ctl.doClose = doClose;
  ctl.whenIdle = () => reconcilePromise || Promise.resolve(true);
  return ctl;
}

module.exports = { DutyDetector, wireDetector, inferDutyTarget, OBSERVER_SOURCE, NUI_URL, sleep };
