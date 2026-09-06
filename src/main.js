// Processo principal: vive na bandeja, sem janela. Faz o login do Discord uma vez,
// roda o DutyDetector e traduz o estado dele em ícone/menu.
const { app, Tray, Menu, dialog, shell, nativeImage, safeStorage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

const { log, setLogFile } = require('./core/logger');
const { DutyDetector, wireDetector, NUI_URL } = require('./core/detector');
const { DiscordClient } = require('./discord');
const { ClipboardHelper } = require('./clipboard-helper');
const { notifyLocal, configureNotifier, attachNotifications } = require('./notifier');
const { closeAllToasts } = require('./toast');
const { setupUpdater, updateReady, installNow, checkNow } = require('./updater');
const { FastDashboard, ORIGIN } = require('./fast-dashboard');

const ASSETS = path.join(__dirname, '..', 'assets');

let tray = null;
let detector = null;
let ctl = null;
let discord = null;
let clipboardHelper = null;
let paused = false;
let loggedIn = false;
let quitting = false;
let logFile = null;
let fastDashboard = null;
let fastDashboardTimer = null;

async function linkFastDashboard() {
  try {
    const data = await fastDashboard.pair();
    if (data.paired) {
      await fastDashboard.heartbeat();
      await dialog.showMessageBox({ type: 'info', title: 'FAST', message: 'Este aplicativo já está vinculado ao dashboard.' });
      return;
    }
    const result = await dialog.showMessageBox({
      type: 'info', title: 'Vincular ao Dashboard FAST',
      message: `Seu código: ${data.code}`,
      detail: 'Válido por 10 minutos. No Dashboard > Ferramentas, confirme o código com sua conta do Discord. O aplicativo informará sua versão, o estado de serviço e a última comunicação ao iniciar, registrar ponto e a cada cinco minutos enquanto estiver aberto.',
      buttons: ['Copiar código e abrir dashboard', 'Fechar'], defaultId: 0, cancelId: 1,
    });
    if (result.response === 0) {
      clipboard.writeText(data.code);
      await shell.openExternal(`${ORIGIN}/dashboard`);
    }
  } catch {
    await dialog.showMessageBox({ type: 'error', title: 'FAST', message: 'Não foi possível vincular agora. Confira sua conexão e tente novamente.' });
  }
}

// O Windows agrupa toasts pelo AppUserModelID. Sem isso, em vez do nome do app
// a notificação sai como "electron.app.Electron".
app.setAppUserModelId('gg.metropole.mtpautotimesheet');

// Só uma instância: duas rodando dariam cliques duplicados no ponto.
if (!app.requestSingleInstanceLock()) app.exit(0);

// App de bandeja: fechar a janela de login não pode encerrar o programa.
app.on('window-all-closed', () => {});

// -------- Config (userData, por usuário) --------

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  try { fs.writeFileSync(configPath(), JSON.stringify(next, null, 2)); } catch {}
  return next;
}

// -------- Iniciar com o Windows --------

function getOpenAtLogin() {
  if (!app.isPackaged) return false;   // em dev apontaria pro electron.exe
  return app.getLoginItemSettings().openAtLogin;
}

function setOpenAtLogin(value) {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: value, args: [] });
  writeConfig({ openAtLogin: value });
}

// -------- Notificações --------

function notificationsEnabled() {
  const cfg = readConfig();
  return cfg.notifications !== false; // ligadas por padrão
}

function soundEnabled() {
  const cfg = readConfig();
  return cfg.sound !== false; // ligado por padrão
}

function clipboardHelperEnabled() {
  const cfg = readConfig();
  return cfg.clipboardHelper !== false; // ligado por padrão
}

function clipboardHelperLabel() {
  if (!clipboardHelperEnabled()) return 'Desativado';
  if (!clipboardHelper) return 'Aguardando inicialização';
  const state = clipboardHelper.state;
  if (state.conflict) return 'Outro auxiliar FAST já está aberto';
  if (state.error) return `Erro — ${state.error}`;
  if (!state.ready) return 'Iniciando';
  if (state.active) {
    const field = state.field || 'próximo campo';
    return `Próximo: ${field} (${state.index + 1}/${state.count})`;
  }
  return 'Ativo — aguardando sequência';
}

function ensureClipboardHelper() {
  if (!clipboardHelper) {
    clipboardHelper = new ClipboardHelper();
    clipboardHelper.on('state', updateTray);
    clipboardHelper.on('helper-error', (message) => {
      notifyLocal('FAST - Auxiliar de Anúncios', message, 'error');
    });
    clipboardHelper.on('helper-event', ({ name, count }) => {
      if (name === 'sequence-ready') {
        notifyLocal('FAST - Auxiliar de Anúncios', `${count} campos preparados. Use Ctrl+V em cada campo do jogo.`, 'success');
      } else if (name === 'sequence-complete') {
        notifyLocal('FAST - Auxiliar de Anúncios', 'Todos os campos foram colados.', 'success');
      } else if (name === 'sequence-cancelled') {
        notifyLocal('FAST - Auxiliar de Anúncios', 'Sequência cancelada. O Ctrl+V voltou ao normal.');
      }
    });
    clipboardHelper.on('exit', ({ conflict, unexpected }) => {
      if (conflict) {
        notifyLocal('FAST - Auxiliar de Anúncios', 'Outro auxiliar FAST já está aberto. Encerre a versão separada para usar a integrada.', 'error');
      } else if (unexpected) {
        notifyLocal('FAST - Auxiliar de Anúncios', 'O componente de colagem foi encerrado inesperadamente.', 'error');
      }
    });
  }
  return clipboardHelper;
}

function startClipboardHelper() {
  if (!clipboardHelperEnabled()) return false;
  return ensureClipboardHelper().start();
}

async function stopClipboardHelper() {
  if (clipboardHelper) await clipboardHelper.stop();
}

async function toggleClipboardHelper(enabled) {
  writeConfig({ clipboardHelper: enabled });
  if (enabled) startClipboardHelper();
  else await stopClipboardHelper();
  updateTray();
}

// -------- Bandeja --------

function trayState() {
  if (!loggedIn) return { icon: 'paused', label: 'Não conectado ao Discord' };
  if (paused) return { icon: 'paused', label: 'Pausado' };
  if (ctl && ctl.pontoOpen) return { icon: 'onduty', label: 'Em serviço — ponto aberto' };
  if (detector && detector.attached) return { icon: 'offduty', label: 'Fora de serviço' };
  return { icon: 'waiting', label: 'Aguardando o FiveM abrir' };
}

function iconFor(name) {
  const img = nativeImage.createFromPath(path.join(ASSETS, `tray-${name}.png`));
  img.setTemplateImage(false);
  return img;
}

function updateTray() {
  if (!tray || quitting) return;
  const { icon, label } = trayState();
  tray.setImage(iconFor(icon));
  tray.setToolTip(`FAST ⚡ — ${label}`);
  const pronta = updateReady();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Status: ${label}`, enabled: false },
    { label: `Versão ${app.getVersion()}`, enabled: false },
    { label: 'Vincular ao Dashboard FAST', click: () => linkFastDashboard() },
    { type: 'separator' },
    ...(pronta ? [
      { label: `Reiniciar e atualizar para ${pronta.version}`, click: () => installNow() },
      { type: 'separator' },
    ] : []),
    ...(loggedIn ? [] : [{ label: 'Entrar no Discord...', click: () => doLogin() }]),
    {
      label: 'Pausar',
      type: 'checkbox',
      checked: paused,
      enabled: loggedIn,
      click: (item) => togglePause(item.checked),
    },
    {
      label: 'Notificações',
      type: 'checkbox',
      checked: notificationsEnabled(),
      click: (item) => { writeConfig({ notifications: item.checked }); updateTray(); },
    },
    {
      label: 'Som',
      type: 'checkbox',
      checked: soundEnabled(),
      enabled: notificationsEnabled(),
      click: (item) => { writeConfig({ sound: item.checked }); updateTray(); },
    },
    { type: 'separator' },
    { label: `Auxiliar de Anúncios: ${clipboardHelperLabel()}`, enabled: false },
    {
      label: 'Ativar Auxiliar de Anúncios',
      type: 'checkbox',
      checked: clipboardHelperEnabled(),
      click: (item) => toggleClipboardHelper(item.checked),
    },
    {
      label: 'Cancelar sequência de anúncio',
      enabled: !!(clipboardHelper && clipboardHelper.state.active),
      click: () => clipboardHelper && clipboardHelper.cancel(),
    },
    {
      label: 'Iniciar com o Windows',
      type: 'checkbox',
      checked: getOpenAtLogin(),
      enabled: app.isPackaged,
      click: (item) => { setOpenAtLogin(item.checked); updateTray(); },
    },
    { type: 'separator' },
    { label: 'Procurar atualização', enabled: app.isPackaged && !pronta, click: () => checkNow() },
    { label: 'Ver logs', click: () => { if (logFile) shell.openPath(logFile); } },
    { label: 'Sair', click: () => doQuit() },
  ]));
}

// -------- Monitor --------

function startMonitor() {
  if (detector) return;
  detector = new DutyDetector();
  ctl = wireDetector(detector, (text) => discord.click(text));
  detector.on('attached', updateTray);
  detector.on('no-connection', updateTray);
  ctl.on('ponto', updateTray);
  ctl.on('ponto', ({ open }) => { if (fastDashboard) void fastDashboard.heartbeat(open); });
  attachNotifications(ctl);

  detector.start().catch((err) => log(`Monitor caiu: ${err.message}`));
  updateTray();
}

// Fecha o ponto antes de largar o monitor: sair (ou pausar) com o ponto
// aberto deixaria hora correndo sem ninguém em serviço.
async function stopMonitor(reason) {
  if (ctl && ctl.pontoOpen) await ctl.doClose(reason);
  if (fastDashboard) await fastDashboard.heartbeat(false);
  if (detector) detector.stop();
  detector = null;
  ctl = null;
}

async function togglePause(next) {
  paused = next;
  updateTray();
  if (paused) {
    log('Pausado pelo usuário.');
    await stopMonitor('pausado pelo usuário');
  } else {
    log('Retomado pelo usuário.');
    startMonitor();
  }
  updateTray();
}

async function doLogin() {
  loggedIn = await discord.ensureLogin();
  updateTray();
  if (loggedIn && !paused) startMonitor();
  return loggedIn;
}

async function doQuit() {
  if (quitting) return;
  quitting = true;
  clearInterval(fastDashboardTimer);
  if (tray) tray.setToolTip('FAST ⚡ — encerrando...');
  log('Encerrando a pedido do usuário.');
  closeAllToasts();
  try {
    await Promise.all([
      stopMonitor('programa encerrado'),
      stopClipboardHelper(),
    ]);
  } catch (err) { log(`Erro ao encerrar: ${err.message}`); }
  app.exit(0);
}

// -------- Boot --------

app.whenReady().then(async () => {
  logFile = setLogFile(path.join(app.getPath('userData'), 'logs', 'mtp-auto-timesheet.log'));
  log(`mtp-auto-timesheet ${app.getVersion()}`);
  log(`Iniciando. FiveM esperado em ${NUI_URL}`);
  log(`Logs em ${logFile}`);

  tray = new Tray(iconFor('waiting'));
  fastDashboard = new FastDashboard({
    version: app.getVersion(),
    loadToken: () => {
      const encrypted = readConfig().fastDashboardToken;
      if (!encrypted) return '';
      try { return safeStorage.decryptString(Buffer.from(encrypted, 'base64')); }
      catch { writeConfig({ fastDashboardToken: '' }); return ''; }
    },
    saveToken: (token) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('secure_storage_unavailable');
      const encrypted = safeStorage.encryptString(token).toString('base64');
      writeConfig({ fastDashboardToken: encrypted });
      if (readConfig().fastDashboardToken !== encrypted) throw new Error('storage_unavailable');
    },
    getOnDuty: () => Boolean(ctl?.pontoOpen),
  });
  void fastDashboard.heartbeat();
  fastDashboardTimer = setInterval(() => { void fastDashboard.heartbeat(); }, 5 * 60 * 1000);
  fastDashboardTimer.unref();
  updateTray();

  // Aviso in-game: tenta o celular nativo (SignalR) primeiro; se nenhum socket
  // foi capturado ainda ou o formato da metrópole mudou, cai no overlay nosso.
  // O appId decide o app/ícone do celular — configurável (default abaixo).
  configureNotifier({
    enabled: notificationsEnabled,
    sound: soundEnabled,
    inGame: async (t, b, type, som) => {
      if (!detector) return false;
      const appId = readConfig().phoneAppId || 'bank';
      if (await detector.notifyPhone(t, b, appId, som)) return true;
      return detector.notifyInGame(t, b, type, som);
    },
  });
  startClipboardHelper();
  discord = new DiscordClient();

  // beforeInstall: o updater reinicia o app, então o ponto precisa fechar antes.
  setupUpdater({
    onChange: updateTray,
    beforeInstall: () => Promise.all([
      stopMonitor('atualizando o programa'),
      stopClipboardHelper(),
    ]),
  });

  // Primeira execução: liga o autostart por padrão, mas só uma vez —
  // se o usuário desmarcar depois, respeitamos a escolha dele.
  const cfg = readConfig();
  if (cfg.openAtLogin === undefined) setOpenAtLogin(true);

  const ok = await doLogin();
  if (!cfg.fastDashboardToken && cfg.fastDashboardPromptedVersion !== app.getVersion()) {
    writeConfig({ fastDashboardPromptedVersion: app.getVersion() });
    await linkFastDashboard();
  }
  if (!ok) {
    log('Login não concluído. Use "Entrar no Discord..." na bandeja quando quiser.');
    dialog.showMessageBox({
      type: 'info',
      title: 'FAST ⚡',
      message: 'Login do Discord não concluído.',
      detail: 'O programa continua na bandeja (perto do relógio). Clique com o botão direito no ícone e escolha "Entrar no Discord..." para tentar de novo.',
    }).catch(() => {});
  }
});

app.on('before-quit', () => {
  clearInterval(fastDashboardTimer);
  if (clipboardHelper) clipboardHelper.stopNow();
});

process.on('uncaughtException', (err) => {
  log(`ERRO não tratado: ${err && err.stack ? err.stack : err}`);
});
