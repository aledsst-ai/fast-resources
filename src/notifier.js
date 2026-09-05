// Avisos ao usuário. Separado do main.js pra poder ser testado sem subir o app inteiro.
//
// Usa uma janela desenhada pelo próprio app (src/toast.js), e não o toast do
// Windows: o nativo depende de o usuário ter as notificações ligadas em
// Configurações, e quando estão desligadas o Electron não avisa — ele
// silenciosamente não aparece. Isso já mordeu aqui.
const { showToast } = require('./toast');

const DEDUP_WINDOW_MS = 60_000;

let lastNotif = { key: '', at: 0 };
let isEnabled = () => true;
let soundOn = () => true;
let notifyInGame = async () => false;

// main.js injeta a leitura do config e o caminho do overlay na NUI.
function configureNotifier({ enabled, inGame, sound } = {}) {
  if (enabled) isEnabled = enabled;
  if (inGame) notifyInGame = inGame;
  if (sound) soundOn = sound;
}

// Dedup: quando o FiveM cai, o fechamento tenta 5 vezes e cada falha traria
// o mesmo aviso. Uma vez por episódio basta.
// Prefere o overlay dentro do jogo: em fullscreen exclusive a janela do Windows
// não aparece. Cai pra janela quando o FiveM está fechado — que é justamente
// quando avisos como "não consegui fechar o ponto" mais importam.
async function notify(title, body, type = 'info') {
  if (!isEnabled()) return false;
  const key = `${title}|${body}`;
  const now = Date.now();
  if (key === lastNotif.key && now - lastNotif.at < DEDUP_WINDOW_MS) return false;
  lastNotif = { key, at: now };

  const som = soundOn();
  try {
    if (await notifyInGame(title, body, type, som)) return true;
  } catch { /* cai pro fallback */ }
  return showToast(title, body, type, som);
}

// Liga os eventos do wireDetector aos avisos na tela.
function attachNotifications(ctl) {
  // O motivo fica só no log; no aviso ele só polui — o jogador acabou de fazer
  // a ação, não precisa que o programa o lembre disso.
  ctl.on('ponto', ({ open }) => {
    if (open) notify('FAST - North Police', 'Ponto aberto no Discord automaticamente.', 'success');
    else notify('FAST - North Police', 'Ponto fechado no Discord automaticamente.', 'success');
  });

  // Falha é o que o usuário mais precisa saber: o ponto pode ter ficado aberto.
  ctl.on('erro', ({ action, message }) => {
    notify(`Falha ao ${action} o ponto`, `${message} Confira o Discord manualmente.`, 'error');
  });
}

module.exports = { notify, configureNotifier, attachNotifications };
