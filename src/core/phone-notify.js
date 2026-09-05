// Notificação nativa no celular do FiveM, via SignalR.
//
// A NUI da metrópole recebe as notificações do celular como uma invocação
// SignalR "Notify" que o servidor manda pelo WebSocket já aberto:
//   {"type":1,"target":"Notify","arguments":[{title,description,appId,duration}]}
// Aqui a gente injeta um frame sintético de "recebido" NESSE mesmo socket, então
// o handler nativo do celular processa como se viesse do servidor — mesma
// aparência, mesmo som.
//
// ATENÇÃO — tradeoff consciente: isto contraria a nota do nui-overlay.js
// ("nada de fabricar mensagem que pareça vinda do servidor"). É frágil por
// natureza: se a metrópole renomear "Notify" ou mudar o payload, para de
// funcionar. Por isso o celular é o caminho PRIMÁRIO, mas o overlay continua
// como fallback (quem chama decide). Diferente do overlay, isto precisa rodar no
// mundo PRINCIPAL da página (não no isolado), pra alcançar a instância viva do
// WebSocket que o cliente SignalR escuta.
const { log } = require('./logger');
const fs = require('fs');
const path = require('path');

const SIGNALR_TARGET = 'Notify';

// Emblema da FAST - North Police incorporado ao aplicativo. Como o payload do
// Notify não aceita ícone (ele vem do appId), a gente troca o background do
// <div> do ícone depois que o card renderiza. O data URI evita depender de uma
// URL externa e continua funcionando mesmo se o repositório estiver privado.
const POLICE_ICON_URL = `data:image/png;base64,${fs.readFileSync(
  path.join(__dirname, '..', '..', 'assets', 'north-police.png')
).toString('base64')}`;

// Som de notificação da polícia (do resource metro-police-tablet). O card do
// celular não toca som sozinho, então tocamos este. O hash no nome muda quando
// o resource é atualizado — se um dia parar de tocar, é só atualizar aqui.
const POLICE_SOUND_URL = 'https://cfx-nui-metro-police-tablet/html/assets/police-notification-19523b58.mp3';

// Injetado no mundo principal de cada frame. Faz duas coisas:
//   1. Patcha WebSocket.prototype.send pra capturar TODOS os sockets SignalR
//      (identificados pelo ping {"type":6} / handshake que mandam). A metrópole
//      tem vários hubs; não dá pra saber de fora qual é o do celular, então
//      guardamos todos. Como o SignalR pinga sozinho a cada ~15s, os sockets são
//      capturados logo após instalar.
//   2. Expõe __mtpPhoneNotify(json), que despacha o MessageEvent 'message' em
//      TODOS os sockets capturados. O hub sem handler "Notify" ignora; o do
//      celular renderiza como se o servidor tivesse mandado.
// IMPORTANTE: sem early-return por "já instalado". A página da NUI persiste entre
// execuções, então precisamos poder ATUALIZAR as funções injetadas. O único
// trecho que roda uma vez só é o wrap do WebSocket.prototype.send (guardado por
// __mtpOrigSend, que preserva o send pristino). A lógica de captura mora em
// window.__mtpOnSend, redefinível a cada injeção.
const CAPTURE_SOURCE = `
(function(){
  var RS = String.fromCharCode(30); // separador de mensagem do SignalR (0x1E)
  if (!window.__mtpSignalRSockets) window.__mtpSignalRSockets = [];
  var sockets = window.__mtpSignalRSockets;

  function isSignalR(data){
    if (typeof data !== 'string' || data.indexOf(RS) === -1) return false;
    return data.indexOf('"type":6') !== -1     // ping
        || data.indexOf('"protocol"') !== -1   // handshake
        || data.indexOf('"type":1') !== -1;    // invocation
  }

  // Coração da captura — redefinível. Guarda SÓ o socket do hub do celular
  // (/hub/phone). CRÍTICO: capturar/despachar em outros hubs (notebook,
  // inventory) injetaria "Notify" neles e bugaria essas interfaces.
  window.__mtpOnSend = function(ws, data){
    try {
      if (isSignalR(data) && /\\/hub\\/phone/i.test(ws.url || '') && sockets.indexOf(ws) === -1) sockets.push(ws);
    } catch(e){}
  };

  try {
    var proto = window.WebSocket && window.WebSocket.prototype;
    if (proto && !proto.__mtpOrigSend) {
      proto.__mtpOrigSend = proto.send;   // preserva o send verdadeiro (uma vez)
      proto.send = function(data){
        try { if (window.__mtpOnSend) window.__mtpOnSend(this, data); } catch(e){}
        return proto.__mtpOrigSend.apply(this, arguments);
      };
    }
  } catch(e){}

  // Diagnóstico: lista os hubs capturados (url, readyState, se tem onmessage).
  window.__mtpSignalRInfo = function(){
    try {
      return JSON.stringify(sockets.map(function(ws){
        return { url: ws.url, readyState: ws.readyState, hasOnmessage: typeof ws.onmessage === 'function' };
      }));
    } catch(e){ return '[]'; }
  };

  // Troca o ícone da notificação nossa. O ícone é um <div> com
  // style="background: url(...app-icons...)". CRÍTICO: limitamos a busca ao CARD
  // da notificação (o toast <li role="status">), NUNCA subindo até a tela toda —
  // senão, enquanto o ícone do card ainda carrega, a busca vazava pros ícones da
  // dock/home e trocava os apps. Retorna quantos ícones trocou.
  window.__mtpPhoneIconFix = function(titleMatch, iconUrl){
    try {
      // elementos-folha cujo texto é o título da nossa notificação
      var titleEls = Array.prototype.slice.call(document.querySelectorAll('p,span,small,div,h1,h2,h3')).filter(function(e){
        return e.children.length === 0 && (e.textContent || '').indexOf(titleMatch) !== -1;
      });
      var patched = 0;
      titleEls.forEach(function(titleEl){
        // sobe SÓ até o container do toast/card — não além.
        var card = titleEl.closest ? titleEl.closest('li[role="status"], [class*="pointer-events-auto"]') : null;
        if (!card) return;
        var icon = Array.prototype.slice.call(card.querySelectorAll('*')).find(function(e){
          var s = (e.getAttribute && e.getAttribute('style')) || '';
          return s.indexOf('app-icons') !== -1;
        });
        if (icon){
          icon.style.background = 'url("' + iconUrl + '") center center / cover';
          patched++;
        }
      });
      return patched;
    } catch(e){ return -1; }
  };

  // Entrega o "Notify" em TODOS os sockets abertos. Usa ws.onmessage DIRETO
  // (caminho garantido — é assim que o SignalR lê os frames). O dispatchEvent é
  // SÓ fallback quando não há onmessage: chamar os dois duplicaria a notificação,
  // porque o dispatch também aciona o onmessage.
  window.__mtpPhoneNotify = function(json){
    try {
      // SÓ o hub do celular — nunca notebook/inventory (o filtro no dispatch
      // protege mesmo se o array tiver sockets velhos de execuções anteriores).
      var socks = sockets.filter(function(ws){ return ws.readyState === 1 && /\\/hub\\/phone/i.test(ws.url || ''); });
      if (!socks.length) return 'no-socket';
      var payload = JSON.parse(json);
      var frame = JSON.stringify({ type:1, target:${JSON.stringify(SIGNALR_TARGET)}, arguments:[payload] }) + RS;
      var sent = 0;
      socks.forEach(function(ws){
        try {
          if (typeof ws.onmessage === 'function') ws.onmessage({ data: frame, type: 'message' });
          else ws.dispatchEvent(new MessageEvent('message', { data: frame }));
          sent++;
        } catch(e){}
      });
      return sent > 0 ? ('ok:' + sent) : 'no-socket';
    } catch(e){ return 'error:' + (e && e.message); }
  };

  return 'installed';
})()
`;

// Instala o capturador num contexto (mundo principal de um frame). Idempotente.
async function installPhoneNotifyContext(session, contextId) {
  try {
    const res = await session.send('Runtime.evaluate', {
      expression: CAPTURE_SOURCE, contextId, returnByValue: true,
    });
    const v = res && res.result && res.result.value;
    return v === 'installed' || v === 'already';
  } catch {
    return false;
  }
}

// Instala em todos os contextos principais conhecidos. Retorna quantos aceitaram.
async function installPhoneNotify(session, contextIds) {
  let ok = 0;
  for (const id of contextIds) {
    if (await installPhoneNotifyContext(session, id)) ok++;
  }
  return ok;
}

// Dispara a notificação em TODOS os contextos — NÃO para no primeiro. O socket do
// celular pode estar num frame/contexto diferente dos outros hubs (notebook,
// inventory); parar no primeiro que tem socket despacharia no hub errado e nunca
// chegaria no do celular. Os hubs sem handler "Notify" ignoram o frame; só o do
// celular renderiza. Retorna true se algum contexto despachou em ≥1 socket.
async function pushPhoneNotify(session, contextIds, payload) {
  const json = JSON.stringify(payload);
  let totalSent = 0;
  let lastReason = 'no-context';
  for (const id of contextIds) {
    try {
      const res = await session.send('Runtime.evaluate', {
        expression: `window.__mtpPhoneNotify(${JSON.stringify(json)})`,
        contextId: id, returnByValue: true,
      });
      const v = res && res.result && res.result.value;
      if (typeof v === 'string' && v.startsWith('ok:')) totalSent += parseInt(v.slice(3), 10) || 0;
      else if (v) lastReason = v;
    } catch (e) {
      lastReason = e.message;
    }
  }
  if (totalSent > 0) {
    log(`Celular: Notify despachado em ${totalSent} socket(s) SignalR.`);
    return true;
  }
  log(`Celular: nenhum socket capturado ainda (${lastReason}). Caindo no overlay.`);
  return false;
}

// Troca o ícone da notificação (título = titleMatch) pela URL dada. Roda em
// todos os contextos e repete algumas vezes, porque o React renderiza o card um
// pouco depois de a mensagem chegar. Para assim que trocar em algum contexto.
async function overridePhoneIcon(session, contextIds, titleMatch, iconUrl, { tries = 8, delayMs = 150 } = {}) {
  const expr = (t, u) => `window.__mtpPhoneIconFix(${JSON.stringify(t)}, ${JSON.stringify(u)})`;
  for (let attempt = 0; attempt < tries; attempt++) {
    for (const id of contextIds) {
      try {
        const res = await session.send('Runtime.evaluate', {
          expression: expr(titleMatch, iconUrl), contextId: id, returnByValue: true,
        });
        const v = res && res.result && res.result.value;
        if (typeof v === 'number' && v > 0) return true;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

// Toca o som da notificação num contexto (o card do celular não toca sozinho).
// IMPORTANTE: o frame raiz 'game' (nui://game/ui/root.html) NÃO carrega mp3 de
// outro resource (erro NETWORK_NO_SOURCE). Os frames cfx-nui-metro-* carregam
// numa boa. Então pulamos qualquer frame que não seja cfx-nui-metro-* e tocamos
// no primeiro que for — a saída de áudio da NUI é compartilhada, então toca uma
// vez só e é audível.
async function playPhoneSound(session, contextIds, url) {
  const expr = `(function(){
    try {
      if (location.href.indexOf('cfx-nui-metro') === -1) return 'skip'; // 'game' e afins não carregam
      var a = new Audio(${JSON.stringify(url)}); a.volume = 0.55;
      var p = a.play(); if (p && p.catch) p.catch(function(){});
      return 'played';
    } catch(e){ return 'err:' + (e && e.message); }
  })()`;
  for (const id of contextIds) {
    try {
      const res = await session.send('Runtime.evaluate', { expression: expr, contextId: id, returnByValue: true });
      if (res && res.result && res.result.value === 'played') return true;
    } catch {}
  }
  return false;
}

// Diagnóstico: junta as URLs dos hubs SignalR capturados em todos os contextos.
async function collectSignalRInfo(session, contextIds) {
  const all = [];
  for (const id of contextIds) {
    try {
      const res = await session.send('Runtime.evaluate', {
        expression: 'window.__mtpSignalRInfo ? window.__mtpSignalRInfo() : "[]"',
        contextId: id, returnByValue: true,
      });
      const raw = res && res.result && res.result.value;
      if (raw && raw !== '[]') {
        for (const s of JSON.parse(raw)) all.push({ ...s, contextId: id });
      }
    } catch {}
  }
  return all;
}

// Monta o payload no formato que o celular espera. appId decide o app/ícone.
// `extra` permite adicionar campos (ex.: um ícone customizado) sem quebrar o resto.
function buildPayload({ title, body, appId, duration = null, extra = null }) {
  return {
    title: String(title),
    description: String(body),
    appId: appId || 'bank',
    duration,
    ...(extra || {}),
  };
}

module.exports = {
  installPhoneNotify, installPhoneNotifyContext, pushPhoneNotify,
  buildPayload, collectSignalRInfo, overridePhoneIcon, playPhoneSound,
  POLICE_ICON_URL, POLICE_SOUND_URL,
};
