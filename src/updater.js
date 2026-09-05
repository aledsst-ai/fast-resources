// Auto-update via GitHub Releases.
//
// Regra de ouro: atualizar reinicia o app, e reiniciar com o ponto aberto
// deixaria hora correndo no Discord sem ninguém em serviço. Por isso nada é
// instalado sem antes passar pelo fechamento gracioso (beforeInstall).
const { app } = require('electron');
const { autoUpdater } = require('electron-updater');
const { log } = require('./core/logger');
const { notify } = require('./notifier');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

let ready = null;        // {version} quando um update está baixado e esperando
let onChange = () => {};
let beforeInstall = async () => {};

function setupUpdater(opts = {}) {
  onChange = opts.onChange || (() => {});
  beforeInstall = opts.beforeInstall || (async () => {});

  // Em dev não existe app-update.yml; checar só geraria erro no log.
  if (!app.isPackaged) {
    log('Auto-update desativado em modo dev.');
    return;
  }

  autoUpdater.autoDownload = true;
  // Se o usuário sair pelo menu, o instalador roda depois — e o doQuit já
  // fechou o ponto antes. É o caminho seguro por padrão.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };

  autoUpdater.on('checking-for-update', () => log('Procurando atualização...'));
  autoUpdater.on('update-not-available', () => log(`Já está na versão mais nova (${app.getVersion()}).`));
  autoUpdater.on('update-available', (info) => log(`Atualização ${info.version} encontrada. Baixando...`));
  autoUpdater.on('error', (err) => log(`Falha no auto-update: ${err && err.message ? err.message : err}`));

  autoUpdater.on('update-downloaded', (info) => {
    ready = { version: info.version };
    log(`Atualização ${info.version} baixada. Será aplicada ao sair, ou pelo menu da bandeja.`);
    notify('Atualização disponível 🔄', `Versão ${info.version} pronta. Use "Reiniciar e atualizar" na bandeja, ou saia do app que ela é aplicada.`);
    onChange();
  });

  check();
  setInterval(check, CHECK_INTERVAL_MS);
}

function check() {
  if (!app.isPackaged) return;
  autoUpdater.checkForUpdates().catch((err) => log(`Não consegui checar atualização: ${err.message}`));
}

function updateReady() {
  return ready;
}

// Fecha o ponto ANTES de reiniciar. Sem isso o Discord ficaria com o ponto aberto.
async function installNow() {
  if (!ready) return;
  log(`Aplicando atualização ${ready.version}: fechando o ponto antes de reiniciar.`);
  try { await beforeInstall(); } catch (err) { log(`Erro ao preparar atualização: ${err.message}`); }
  autoUpdater.quitAndInstall();
}

module.exports = { setupUpdater, updateReady, installNow, checkNow: check };
