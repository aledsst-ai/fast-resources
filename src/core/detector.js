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

// -------- Observer script injetado no metro-inventory --------

const OBSERVER_SOURCE = `
(function(){
  if (window.__mtpAutoTimesheetInstalled) return 'already';
  window.__mtpAutoTimesheetInstalled = true;

  var lastText = null;
  var send = function(text){
    try { window.${BINDING_NAME}(JSON.stringify({ text: text || '' })); } catch(e) {}
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
      send(text);
    }
    if (!fromInner && s !== trackedSpan) {
      innerObs.disconnect();
      trackedSpan = s;
      if (s) innerObs.observe(s, { characterData: true, childList: true, subtree: true });
    }
  }
  var rootObs = new MutationObserver(function(){ checkAndDispatch(false); });
  rootObs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
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
    if (this.session) this.session.close();
  }

  _dispatch(status, text, source) {
    if (status === this._lastEmittedStatus) return;
    this._lastEmittedStatus = status;
    this.emit('status', { status, text: text || '', source });
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
        const text = payload.text || '';
        const status = !text ? 'unknown'
          : /fora de servi/i.test(text) ? 'off-duty'
          : 'on-duty';
        this._dispatch(status, text, 'observer');
      });

      // Frame navegou/foi anexado → tenta (re)injetar observer no metro-inventory se aparecer
      const maybeInject = async () => { await this._tryInjectObserver(session).catch(() => {}); };
      session.on('Page.frameNavigated', maybeInject);
      session.on('Page.frameAttached', maybeInject);

      // Captura o Bearer token diretamente dos requests que o tablet faz à API.
      // É à prova de login: sempre pega o token atual que o jogo está usando,
      // sem depender de onde ele foi guardado (localStorage vs. memória).
      session.on('Network.requestWillBeSent', (ev) => {
        this._captureTokenFromHeaders(ev.request && ev.request.headers, ev.request && ev.request.url);
      });
      session.on('Network.requestWillBeSentExtraInfo', (ev) => {
        this._captureTokenFromHeaders(ev.headers, null);
      });

      // Agora habilita os domínios (listeners já estão registrados)
      await session.send('Runtime.enable');
      await session.send('Page.enable');
      await session.send('Network.enable');
      await session.send('Runtime.addBinding', { name: BINDING_NAME });

      // Primeira tentativa de injeção (se inventário já estiver aberto)
      await this._tryInjectObserver(session);

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

  // Extrai o Bearer token do header Authorization de um request observado na rede.
  // Fonte primária e à prova de login — o tablet (cfx-nui-metro-police-tablet) manda
  // o token pronto em toda chamada à api.metropole.gg.
  _captureTokenFromHeaders(headers, url) {
    if (!headers) return;
    let auth = null;
    for (const k in headers) {
      if (k.toLowerCase() === 'authorization') { auth = headers[k]; break; }
    }
    if (!auth || !/(^|\s)eyJ[A-Za-z0-9_-]+\./.test(auth)) return;
    // Se soubermos a URL, só nos importa a API da metropole; extraInfo não traz URL.
    if (url && !/api\.metropole\.gg/i.test(url)) return;
    const bearer = /^Bearer\s/i.test(auth) ? auth : `Bearer ${auth}`;
    if (bearer === this._bearerToken) return;
    const wasEmpty = !this._bearerToken;
    this._bearerToken = bearer;
    const where = url ? new URL(url).pathname : 'rede';
    log(`Token capturado via ${where}.${wasEmpty ? ' Poll API ativo.' : ' (rotacionado após login)'}`);
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

  async _tryInjectObserver(session) {
    try {
      const { frameTree } = await session.send('Page.getFrameTree');
      const frame = flattenFrames(frameTree).find(
        (f) => /metro-inventory/i.test(f.name || '') || /metro-inventory/i.test(f.url || '')
      );
      if (!frame) { this.observerInstalled = false; return false; }
      const iso = await session.send('Page.createIsolatedWorld', {
        frameId: frame.id, worldName: ISOLATED_WORLD_NAME, grantUniveralAccess: true,
      });
      const res = await session.send('Runtime.evaluate', {
        expression: OBSERVER_SOURCE, contextId: iso.executionContextId, returnByValue: true,
      });
      const outcome = res && res.result && res.result.value;
      const ok = (outcome === 'installed' || outcome === 'already');
      if (ok && !this.observerInstalled) log('Observer injetado no metro-inventory.');
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

  async _pollOnce() {
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

      if (res.status === 401) {
        log('Token expirado (401). Invalidando cache; aguardando novo token.');
        this._bearerToken = null;
        return;
      }
      if (!res.ok) return;

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
    } catch {
      // erro de rede: silencioso
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
  let closing = false;
  let opening = false;

  const setPonto = (open) => { pontoOpen = open; ctl.emit('ponto', { open }); };

  const doOpen = async () => {
    if (pontoOpen || opening) return false;
    opening = true;
    try {
      await clickButton('Abrir Ponto');
      setPonto(true);
      log('>>> PONTO ABERTO <<<');
      return true;
    } catch (e) {
      log(`Falha ao abrir ponto: ${e.message}`);
      ctl.emit('erro', { action: 'abrir', message: e.message });
      return false;
    } finally { opening = false; }
  };

  const doClose = async (reason) => {
    if (!pontoOpen || closing) return false;
    closing = true;
    try {
      await clickButton('Fechar Ponto');
      setPonto(false);
      // O motivo fica só aqui, no log, pra diagnóstico — fora do aviso na tela.
      log(`>>> PONTO FECHADO (${reason}) <<<`);
      return true;
    } catch (e) {
      log(`Falha ao fechar ponto: ${e.message}`);
      ctl.emit('erro', { action: 'fechar', message: e.message });
      return false;
    } finally { closing = false; }
  };

  detector.on('status', ({ status, text, source }) => {
    log(`[status change via ${source}] ${status} — "${text}"`);
    if (status === 'on-duty') doOpen();
    else if (status === 'off-duty') doClose('saiu de serviço');
  });

  // FiveM perdido (você fechou o jogo). Se estiver em serviço, fecha o ponto
  // automaticamente. O monitor NUNCA encerra por isso: ele volta a sondar a rota
  // e reanexa sozinho quando o jogo abrir de novo.
  detector.on('no-connection', async () => {
    log('Conexão com o FiveM perdida (sustentada). Sigo verificando até o jogo voltar.');
    if (!pontoOpen) return;
    for (let attempt = 1; attempt <= CLOSE_RETRY_ATTEMPTS && pontoOpen; attempt++) {
      if (await doClose('FiveM fechado')) return;
      log(`Não consegui fechar o ponto (tentativa ${attempt}/${CLOSE_RETRY_ATTEMPTS}). Nova tentativa em ${CLOSE_RETRY_DELAY_MS / 1000}s.`);
      await sleep(CLOSE_RETRY_DELAY_MS);
    }
    if (pontoOpen) log('ATENÇÃO: o ponto continua aberto e não consegui fechar. Feche manualmente no Discord.');
  });

  detector.on('stopped', () => { log('Monitor encerrado.'); });

  Object.defineProperty(ctl, 'pontoOpen', { get: () => pontoOpen });
  ctl.doOpen = doOpen;
  ctl.doClose = doClose;
  return ctl;
}

module.exports = { DutyDetector, wireDetector, NUI_URL, sleep };
