// Camada Discord sobre o Chromium do próprio Electron (substitui o Playwright).
//
// A sessão fica na partition 'persist:discord', dentro do userData do usuário
// (%APPDATA%/mtp-auto-timesheet). Cada pessoa faz o próprio login: nada de sessão
// viaja no instalador.
const { BrowserWindow, session } = require('electron');
const { log } = require('./core/logger');

// Canal do ponto da FAST - North Police (Metrópole). É só o link do canal —
// dá pra trocar por outro servidor mudando esta linha.
const DISCORD_CHANNEL_URL = 'https://discord.com/channels/1197567547936079922/1222646689203097772';
const DISCORD_HOME_URL = 'https://discord.com/channels/@me';
const PARTITION = 'persist:discord';

const LOAD_TIMEOUT_MS = 45_000;
const CHANNEL_READY_TIMEOUT_MS = 40_000;
const CLICK_TIMEOUT_MS = 30_000;
const LOGIN_PROBE_MS = 2_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// O Discord web recusa navegadores que não reconhece. O Electron é Chromium,
// então anunciamos a versão real do Chromium embutido em vez do UA "Electron".
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`;

const LOGGED_IN_PROBE = `!!document.querySelector('[data-list-id="guildsnav"]')`;
const CHANNEL_READY_PROBE = `!!document.querySelector('[data-list-id="chat-messages"], main[class*="chatContent"]')`;

// Rola até o fim: o Discord virtualiza a lista, e um botão fora da viewport
// simplesmente não existe no DOM.
const SCROLL_BOTTOM = `
(() => {
  const cands = document.querySelectorAll('[class*="scroller"]');
  let done = false;
  for (const s of cands) {
    if (s.scrollHeight > s.clientHeight + 10) { s.scrollTop = s.scrollHeight; done = true; }
  }
  return done;
})()
`;

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Procura o botão pelo texto. Pega o ÚLTIMO match: no Discord o mais recente
// fica embaixo, e o canal pode ter painéis antigos com o mesmo botão.
function buildClickScript(text) {
  return `
(() => {
  const rx = new RegExp(${JSON.stringify(escapeRegex(text))}, 'i');
  const nodes = Array.from(document.querySelectorAll('button, [role="button"]'));
  const hits = nodes.filter((el) => {
    if (!rx.test(el.textContent || '')) return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!hits.length) return { clicked: false, matches: 0 };
  const el = hits[hits.length - 1];
  el.scrollIntoView({ block: 'center' });
  el.click();
  return { clicked: true, matches: hits.length };
})()
`;
}

function createWindow(show) {
  const win = new BrowserWindow({
    show,
    width: 1180,
    height: 820,
    title: 'FAST ⚡ — Discord',
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.webContents.setUserAgent(CHROME_UA);
  return win;
}

function loadUrl(win, url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout carregando ${url}`)), LOAD_TIMEOUT_MS);
    const done = (err) => { clearTimeout(timer); err ? reject(err) : resolve(); };
    win.webContents.once('did-finish-load', () => done());
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      if (code === -3) return; // ERR_ABORTED: redirect interno do SPA, não é falha
      done(new Error(`Falha ao carregar (${code}): ${desc}`));
    });
    win.loadURL(url).catch(done);
  });
}

// Espera uma expressão JS virar true na página, com timeout.
async function waitFor(win, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (win.isDestroyed()) throw new Error('Janela fechada durante a espera.');
    const ok = await win.webContents.executeJavaScript(expression).catch(() => false);
    if (ok) return true;
    await sleep(700);
  }
  throw new Error(`Timeout esperando: ${label}`);
}

// Existe alguma sessão salva? Numa instalação nova a resposta é não, e é
// instantânea — não há cookie pra sondar.
//
// Consulta TODOS os cookies da partition, sem filtrar por domínio: ela é usada
// só pro Discord, então qualquer cookie significa que já estivemos lá. Errar
// dizendo "tem sessão" custa uma verificação de 25s; errar dizendo "não tem"
// jogaria uma janela de login na cara de quem já está logado. Na dúvida, o
// falso positivo é o lado barato.
async function hasSavedSession() {
  try {
    const cookies = await session.fromPartition(PARTITION).cookies.get({});
    return cookies.length > 0;
  } catch {
    return true; // na dúvida, faz a verificação completa
  }
}

class DiscordClient {
  constructor() {
    this.loginWin = null;
  }

  async isLoggedIn() {
    // Atalho da primeira execução. Sem isso o usuário instala e encara ~25s de
    // tela vazia enquanto sondamos uma sessão que nunca existiu — e conclui que
    // o programa travou. O login tem que ser a primeira coisa que ele vê.
    if (!(await hasSavedSession())) {
      log('Nenhuma sessão do Discord salva — primeira execução.');
      return false;
    }

    const win = createWindow(false);
    try {
      await loadUrl(win, DISCORD_HOME_URL);
      // O SPA leva um tempo pra montar; a URL virar /login é resposta definitiva.
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        if (win.webContents.getURL().includes('/login')) return false;
        const ok = await win.webContents.executeJavaScript(LOGGED_IN_PROBE).catch(() => false);
        if (ok) return true;
        await sleep(LOGIN_PROBE_MS);
      }
      return false;
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }

  // Abre a janela pro usuário logar e espera ele terminar. Sem stdin/ENTER:
  // detectamos o login sozinhos, porque num app de bandeja não há console.
  async promptLogin() {
    log('Discord não logado. Abrindo janela para login.');
    const win = createWindow(true);
    this.loginWin = win;
    let closedByUser = false;
    win.on('closed', () => { closedByUser = true; this.loginWin = null; });

    try {
      await loadUrl(win, 'https://discord.com/login');
      while (!closedByUser && !win.isDestroyed()) {
        const ok = await win.webContents.executeJavaScript(LOGGED_IN_PROBE).catch(() => false);
        if (ok) {
          log('Login detectado. Sessão salva — não vou pedir de novo.');
          await sleep(1500); // deixa o Discord gravar os cookies antes de fechar
          if (!win.isDestroyed()) win.destroy();
          this.loginWin = null;
          return true;
        }
        await sleep(LOGIN_PROBE_MS);
      }
      return false;
    } catch (err) {
      log(`Erro na janela de login: ${err.message}`);
      if (!win.isDestroyed()) win.destroy();
      this.loginWin = null;
      return false;
    }
  }

  async ensureLogin() {
    if (await this.isLoggedIn()) {
      log('Sessão do Discord válida.');
      return true;
    }
    return this.promptLogin();
  }

  // Clica no botão do canal. Janela sob demanda, destruída no fim: o ponto abre
  // e fecha poucas vezes por sessão, então não vale manter o Discord na memória.
  async click(buttonText) {
    const win = createWindow(false);
    try {
      await loadUrl(win, DISCORD_CHANNEL_URL);
      await waitFor(win, CHANNEL_READY_PROBE, CHANNEL_READY_TIMEOUT_MS, 'canal carregar');

      const deadline = Date.now() + CLICK_TIMEOUT_MS;
      let lastMatches = 0;
      while (Date.now() < deadline) {
        await win.webContents.executeJavaScript(SCROLL_BOTTOM).catch(() => {});
        const res = await win.webContents
          .executeJavaScript(buildClickScript(buttonText))
          .catch(() => ({ clicked: false, matches: 0 }));
        lastMatches = res.matches || 0;
        if (res.clicked) {
          log(`Clique em "${buttonText}" realizado${res.matches > 1 ? ` (${res.matches} botões encontrados, usei o mais recente)` : ''}.`);
          await sleep(2500); // deixa o Discord mandar a interação antes de fechar
          return true;
        }
        await sleep(1000);
      }
      throw new Error(`Botão "${buttonText}" não localizado no canal (matches=${lastMatches}).`);
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }
}

module.exports = { DiscordClient };
