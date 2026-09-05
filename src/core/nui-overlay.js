// Overlay de avisos dentro da NUI do FiveM.
//
// Por que aqui e não numa janela do Windows: em fullscreen exclusive o jogo tem
// o display, e janela externa nenhuma aparece. A NUI é CEF composto pelo próprio
// jogo — o que vive nela é desenhado junto com o frame do GTA e sempre aparece.
//
// Injetamos um elemento NOSSO, não chamamos código da Metrópole: nada de depender
// de função interna deles (que quebraria a cada atualização) nem de fabricar
// mensagem que pareça vinda do servidor.
//
// Sem Electron aqui: só CDP, pra continuar testável com node puro.
const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const WORLD_NAME = 'mtpAutoTimesheetOverlay';
const CONTAINER_ID = '__mtp_auto_timesheet_overlay__';
const DEFAULT_DURATION_MS = 6000;

// RGB puro (sem #) pra montar rgba() com a transparência que deixa ver o jogo atrás.
const COLORS = {
  success: '22,163,74',
  warning: '217,119,6',
  error: '220,38,38',
  info: '79,70,229',
};
const BG_ALPHA = 0.82;

// O som viaja embutido no script: a NUI é nui:// e não conseguiria buscar um
// arquivo nosso do disco. Lido uma vez e cacheado (~15KB em base64).
let soundCache = null;
function soundDataUri() {
  if (soundCache !== null) return soundCache;
  try {
    soundCache = `data:audio/wav;base64,${fs.readFileSync(path.join(ASSETS, 'notify.wav')).toString('base64')}`;
  } catch {
    soundCache = ''; // sem som é melhor que sem aviso
  }
  return soundCache;
}

// Instalado uma vez por contexto. Define __mtpAutoTimesheetPush para os avisos.
const buildInstallSource = () => `
(function(){
  var ID = ${JSON.stringify(CONTAINER_ID)};
  if (window.__mtpAutoTimesheetPush && document.getElementById(ID)) return 'already';

  var SND = ${JSON.stringify(soundDataUri())};
  var audio = null;
  if (SND) {
    try {
      audio = new Audio(SND);
      audio.volume = 0.45;
      audio.preload = 'auto';
    } catch (e) { audio = null; }
  }

  var box = document.getElementById(ID);
  if (!box) {
    box = document.createElement('div');
    box.id = ID;
    // pointer-events:none é essencial: sem isso o overlay engoliria cliques do jogo.
    box.style.cssText = [
      'position:fixed', 'top:24px', 'right:24px', 'z-index:2147483647',
      'pointer-events:none', 'display:flex', 'flex-direction:column',
      'gap:8px', 'align-items:flex-end',
      'font-family:"Segoe UI",system-ui,sans-serif'
    ].join(';');
    (document.body || document.documentElement).appendChild(box);
  }

  if (!document.getElementById(ID + '_style')) {
    var st = document.createElement('style');
    st.id = ID + '_style';
    st.textContent = [
      '@keyframes ats-in { from { opacity:0; transform:translateX(28px); } to { opacity:1; transform:translateX(0); } }',
      '@keyframes ats-out { from { opacity:1; transform:translateX(0); } to { opacity:0; transform:translateX(28px); } }',
      // Sem border-radius e com o fundo na cor inteira: a transparência deixa
      // o jogo aparecer atrás, e a cor sozinha já comunica sucesso/aviso/erro.
      '#' + ID + ' .ats-card { display:block; width:340px; padding:11px 14px;',
      '  border-radius:0; animation:ats-in 240ms ease-out both; }',
      '#' + ID + ' .ats-t { color:#fff; font-size:13px; font-weight:700; margin-bottom:2px;',
      '  text-shadow:0 1px 2px rgba(0,0,0,.35);',
      '  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
      '#' + ID + ' .ats-b { color:rgba(255,255,255,.93); font-size:11.5px; line-height:1.35;',
      '  text-shadow:0 1px 2px rgba(0,0,0,.3);',
      '  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }'
    ].join('\\n');
    (document.head || document.documentElement).appendChild(st);
  }

  window.__mtpAutoTimesheetPush = function(json){
    try {
      var d = JSON.parse(json);
      var card = document.createElement('div');
      card.className = 'ats-card';
      card.style.background = d.bg;

      var t = document.createElement('div');
      t.className = 'ats-t';
      t.textContent = d.title;
      var b = document.createElement('div');
      b.className = 'ats-b';
      b.textContent = d.body;

      card.appendChild(t); card.appendChild(b);
      box.appendChild(card);

      while (box.children.length > 3) box.removeChild(box.firstChild);

      // Reusa o mesmo Audio: avisos em sequência cortam o anterior em vez de
      // empilhar barulho. O catch cobre bloqueio de autoplay sem quebrar o card.
      if (audio && d.sound !== false) {
        try { audio.currentTime = 0; var pr = audio.play(); if (pr && pr.catch) pr.catch(function(){}); } catch (e) {}
      }

      setTimeout(function(){
        card.style.animation = 'ats-out 240ms ease-in both';
        setTimeout(function(){ if (card.parentNode) card.parentNode.removeChild(card); }, 240);
      }, d.duration);
      return true;
    } catch (e) { return false; }
  };
  return 'installed';
})()
`;

// Cria o mundo isolado e instala. Mundo isolado compartilha o DOM mas isola o JS,
// então não encostamos nas globais dos resources da Metrópole.
async function installOverlay(session, frameId) {
  const iso = await session.send('Page.createIsolatedWorld', {
    frameId, worldName: WORLD_NAME, grantUniveralAccess: true,
  });
  const res = await session.send('Runtime.evaluate', {
    expression: buildInstallSource(),
    contextId: iso.executionContextId,
    returnByValue: true,
  });
  const outcome = res && res.result && res.result.value;
  if (outcome !== 'installed' && outcome !== 'already') {
    throw new Error(`overlay não instalou (retorno: ${outcome})`);
  }
  return iso.executionContextId;
}

async function pushOverlay(session, contextId, { title, body, type = 'info', duration = DEFAULT_DURATION_MS, sound = true }) {
  const rgb = COLORS[type] || COLORS.info;
  const payload = JSON.stringify({
    title: String(title),
    body: String(body),
    bg: `rgba(${rgb},${BG_ALPHA})`,
    duration,
    sound,
  });
  const res = await session.send('Runtime.evaluate', {
    // JSON.stringify duas vezes: uma pro payload, outra pra virar literal de string no JS.
    expression: `window.__mtpAutoTimesheetPush(${JSON.stringify(payload)})`,
    contextId,
    returnByValue: true,
  });
  return !!(res && res.result && res.result.value === true);
}

module.exports = { installOverlay, pushOverlay, WORLD_NAME, CONTAINER_ID };
