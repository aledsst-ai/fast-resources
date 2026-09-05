// Notificação desenhada pelo próprio app, em vez do toast do Windows.
//
// Motivo: o toast nativo depende de o usuário ter as notificações ligadas em
// Configurações (ToastEnabled). Se estiverem desligadas, o Electron nem avisa —
// ele simplesmente não aparece. Uma janela nossa sempre funciona.
//
// Cuidados: showInactive() pra não roubar o foco do jogo, e nível 'screen-saver'
// pra tentar ficar acima do FiveM.
const { BrowserWindow, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { log } = require('./core/logger');

const ASSETS = path.join(__dirname, '..', 'assets');

const WIDTH = 380;
const HEIGHT = 92;
const GAP = 10;
const MARGIN = 16;
// Override existe pra teste conseguir segurar o card na tela e conferir o visual.
const DURATION_MS = Number(process.env.MTP_AUTO_TIMESHEET_TOAST_MS) || 6000;
const FADE_MS = 260;
const MAX_VISIBLE = 3;

// RGB puro pra montar rgba() — a transparência deixa ver o que está atrás.
const COLORS = {
  success: '22,163,74',
  warning: '217,119,6',
  error: '220,38,38',
  info: '79,70,229',
};
const BG_ALPHA = 0.82;

const active = []; // janelas na tela, de baixo pra cima
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

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function buildHtml(title, body, bg, sound) {
  const snd = sound ? soundDataUri() : '';
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { background: transparent; overflow: hidden; -webkit-user-select: none; cursor: default; }
  body { font-family: "Segoe UI", system-ui, sans-serif; }
  /* A entrada é animação pura de CSS de propósito: se dependesse de JS pra
     tirar o opacity:0, um script bloqueado deixaria o card invisível pra
     sempre — janela na tela, conteúdo transparente, e nenhum erro. */
  .card {
    display: flex; align-items: center; gap: 12px;
    height: ${HEIGHT}px; padding: 14px 16px;
    background: ${bg}; border-radius: 0;
    box-shadow: 0 6px 20px rgba(0,0,0,.35);
    animation: slide-in ${FADE_MS}ms ease-out both;
  }
  @keyframes slide-in {
    from { opacity: 0; transform: translateX(24px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  .card.out {
    animation: slide-out ${FADE_MS}ms ease-in both;
  }
  @keyframes slide-out {
    from { opacity: 1; transform: translateX(0); }
    to   { opacity: 0; transform: translateX(24px); }
  }
  .txt { min-width: 0; }
  .t { color: #fff; font-size: 13.5px; font-weight: 700; margin-bottom: 3px;
       text-shadow: 0 1px 2px rgba(0,0,0,.35);
       white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .b { color: rgba(255,255,255,.93); font-size: 12px; line-height: 1.35;
       text-shadow: 0 1px 2px rgba(0,0,0,.3);
       display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
</style></head>
<body>
  <div class="card" id="c">
    <div class="txt">
      <div class="t">${escapeHtml(title)}</div>
      <div class="b">${escapeHtml(body)}</div>
    </div>
  </div>
  <!-- autoplay declarativo, não JS: script inline não roda neste contexto
       (foi o que deixou o card invisível na primeira versão). -->
  ${snd ? `<audio src="${snd}" autoplay></audio>` : ''}
</body></html>`;
}

function layout() {
  const { workArea } = screen.getPrimaryDisplay();
  active.forEach((win, i) => {
    if (win.isDestroyed()) return;
    const y = workArea.y + workArea.height - MARGIN - (HEIGHT + GAP) * (i + 1);
    win.setPosition(workArea.x + workArea.width - WIDTH - MARGIN, y, false);
  });
}

function dismiss(win) {
  const i = active.indexOf(win);
  if (i === -1) return;
  active.splice(i, 1);
  if (win.isDestroyed()) { layout(); return; }
  win.webContents
    .executeJavaScript(`document.getElementById('c').classList.add('out')`)
    .catch(() => {});
  setTimeout(() => { if (!win.isDestroyed()) win.destroy(); layout(); }, FADE_MS);
  layout();
}

// type: 'success' | 'warning' | 'error' | 'info'
function showToast(title, body, type = 'info', sound = true) {
  try {
    while (active.length >= MAX_VISIBLE) dismiss(active[0]);

    const { workArea } = screen.getPrimaryDisplay();
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      x: workArea.x + workArea.width - WIDTH - MARGIN,
      y: workArea.y + workArea.height - MARGIN - HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      focusable: false,       // não rouba o foco do jogo
      alwaysOnTop: true,
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });

    // 'screen-saver' é o nível mais alto — sobe acima de janelas de jogo.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true);

    const bg = `rgba(${COLORS[type] || COLORS.info},${BG_ALPHA})`;
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildHtml(title, body, bg, sound))}`);

    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.showInactive(); // mostra sem ativar
      active.push(win);
      layout();
    });

    win.webContents.on('before-input-event', () => dismiss(win));
    setTimeout(() => dismiss(win), DURATION_MS);
    return true;
  } catch (err) {
    log(`Não consegui exibir a notificação: ${err.message}`);
    return false;
  }
}

function closeAllToasts() {
  for (const win of [...active]) dismiss(win);
}

module.exports = { showToast, closeAllToasts };
