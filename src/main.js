// Processo principal: vive na bandeja, sem janela. Faz o login do Discord uma vez,
// roda o DutyDetector e traduz o estado dele em ícone/menu.
const { app, Tray, Menu, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const { log, setLogFile } = require('./core/logger');
const { DutyDetector, wireDetector, NUI_URL } = require('./core/detector');
const { DiscordClient } = require('./discord');
const { configureNotifier, attachNotifications } = require('./notifier');
const { closeAllToasts } = require('./toast');
const { setupUpdater, updateReady, installNow, checkNow } = require('./updater');

const ASSETS = path.join(__dirname, '..', 'assets');
const AUTOR = '@guip1_';

let tray = null;
let detector = null;
let ctl = null;
let discord = null;
let paused = false;
let loggedIn = false;
let quitting = false;
let logFile = null;

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
  tray.setToolTip(`mtp-auto-timesheet — ${label}`);
  const pronta = updateReady();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Status: ${label}`, enabled: false },
    { label: `Versão ${app.getVersion()} — por ${AUTOR}`, enabled: false },
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
  attachNotifications(ctl);

  detector.start().catch((err) => log(`Monitor caiu: ${err.message}`));
  updateTray();
}

// Fecha o ponto antes de largar o monitor: sair (ou pausar) com o ponto
// aberto deixaria hora correndo sem ninguém em serviço.
async function stopMonitor(reason) {
  if (ctl && ctl.pontoOpen) await ctl.doClose(reason);
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
  if (tray) tray.setToolTip('mtp-auto-timesheet — encerrando...');
  log('Encerrando a pedido do usuário.');
  closeAllToasts();
  try { await stopMonitor('programa encerrado'); } catch (err) { log(`Erro ao encerrar: ${err.message}`); }
  app.exit(0);
}

// -------- Boot --------

app.whenReady().then(async () => {
  logFile = setLogFile(path.join(app.getPath('userData'), 'logs', 'mtp-auto-timesheet.log'));
  log(`mtp-auto-timesheet ${app.getVersion()} — desenvolvido por ${AUTOR}`);
  log(`Iniciando. FiveM esperado em ${NUI_URL}`);
  log(`Logs em ${logFile}`);

  tray = new Tray(iconFor('waiting'));
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
  discord = new DiscordClient();

  // beforeInstall: o updater reinicia o app, então o ponto precisa fechar antes.
  setupUpdater({
    onChange: updateTray,
    beforeInstall: () => stopMonitor('atualizando o programa'),
  });

  // Primeira execução: liga o autostart por padrão, mas só uma vez —
  // se o usuário desmarcar depois, respeitamos a escolha dele.
  const cfg = readConfig();
  if (cfg.openAtLogin === undefined) setOpenAtLogin(true);

  const ok = await doLogin();
  if (!ok) {
    log('Login não concluído. Use "Entrar no Discord..." na bandeja quando quiser.');
    dialog.showMessageBox({
      type: 'info',
      title: 'mtp-auto-timesheet',
      message: 'Login do Discord não concluído.',
      detail: 'O programa continua na bandeja (perto do relógio). Clique com o botão direito no ícone e escolha "Entrar no Discord..." para tentar de novo.',
    }).catch(() => {});
  }
});

process.on('uncaughtException', (err) => {
  log(`ERRO não tratado: ${err && err.stack ? err.stack : err}`);
});
