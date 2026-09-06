const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const root = path.join(__dirname, '..');

test('Discord aponta para o servidor e canal da FAST', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'discord.js'), 'utf8');
  assert.match(source, /discord\.com\/channels\/1197567547936079922\/1222646689203097772/);
  assert.match(source, /Abrir Ponto|buttonText/);
});

test('detector reconhece nomes da North Police', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'core', 'detector.js'), 'utf8');
  const literal = source.match(/if \(\/(\(\?:Pol\[ií\].+?North\[ \]\+Police\))\/i\.test\(t\)\)/);
  assert.ok(literal, 'regex de corporação não encontrada');
  const rx = new RegExp(literal[1], 'i');
  for (const name of [
    'Polícia Norte',
    'Policia do Norte',
    'Polícia Militar Norte',
    'Polícia Militar do Norte',
    'North Police',
    'FAST - North Police',
  ]) assert.match(name, rx);
  assert.doesNotMatch('Polícia Capital', rx);
});

test('notificações usam a identidade FAST - North Police', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'notifier.js'), 'utf8');
  assert.equal((source.match(/FAST - North Police/g) || []).length, 2);
  assert.match(source, /✅ Ponto aberto com sucesso/);
  assert.match(source, /✅ Ponto fechado com sucesso/);
  assert.doesNotMatch(source, /Pol[ií]cia Capital/i);
});

test('interface exibe o nome FAST com o raio', () => {
  const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  const discord = fs.readFileSync(path.join(root, 'src', 'discord.js'), 'utf8');
  assert.match(main, /FAST ⚡ — \$\{label\}/);
  assert.match(main, /FAST ⚡ — encerrando/);
  assert.match(main, /title: 'FAST ⚡'/);
  assert.match(discord, /title: 'FAST ⚡ — Discord'/);
});

test('ícones da bandeja usam o emblema FAST em 16 e 32 px', () => {
  const states = ['waiting', 'offduty', 'onduty', 'paused'];
  for (const [suffix, size] of [['', 16], ['@2x', 32]]) {
    const icons = states.map((state) => fs.readFileSync(path.join(root, 'assets', `tray-${state}${suffix}.png`)));
    for (const icon of icons) {
      assert.equal(icon.subarray(1, 4).toString('ascii'), 'PNG');
      assert.equal(icon.readUInt32BE(16), size);
      assert.equal(icon.readUInt32BE(20), size);
      assert.ok(icon.length > 700, 'ícone simplificado antigo ainda presente');
      assert.deepEqual(icon, icons[0]);
    }
  }
});

test('avisos do Auxiliar de Anúncios não são enviados ao celular do FiveM', () => {
  const notifier = fs.readFileSync(path.join(root, 'src', 'notifier.js'), 'utf8');
  const localBody = notifier.match(/function notifyLocal[\s\S]+?\n}/)?.[0] || '';
  assert.match(localBody, /showToast/);
  assert.doesNotMatch(localBody, /notifyInGame/);

  const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  assert.match(main, /notifyLocal\('FAST - Auxiliar de Anúncios'/);
});

test('emblema da North Police está incorporado ao pacote', () => {
  const icon = fs.readFileSync(path.join(root, 'assets', 'north-police.png'));
  assert.equal(icon.subarray(1, 4).toString('ascii'), 'PNG');
  const source = fs.readFileSync(path.join(root, 'src', 'core', 'phone-notify.js'), 'utf8');
  assert.match(source, /north-police\.png/);
  assert.match(source, /data:image\/png;base64/);
});

test('publicação estável aponta para o repositório de atualizações', () => {
  const pkg = require(path.join(root, 'package.json'));
  assert.equal(pkg.version, '1.1.10');
  assert.equal(pkg.testBuild, undefined);
  assert.equal(pkg.build.appId, 'gg.metropole.mtpautotimesheet');
  assert.deepEqual(pkg.build.publish[0], {
    provider: 'github',
    owner: 'aledsst-ai',
    repo: 'fast-resources',
  });
});

test('Discord sempre clica no botão solicitado e não infere estado por outro botão', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'discord.js'), 'utf8');
  assert.match(source, /buildClickScript\(buttonText\)/);
  assert.doesNotMatch(source, /alreadyDesired|oppositeText|Discord já está no estado desejado/);
});

test('produção mantém inicialização automática e atualização habilitadas', () => {
  const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  const updater = fs.readFileSync(path.join(root, 'src', 'updater.js'), 'utf8');
  assert.match(main, /setOpenAtLogin\(true\)/);
  assert.match(updater, /autoUpdater\.autoDownload = true/);
  assert.match(updater, /setInterval\(check, CHECK_INTERVAL_MS\)/);
  assert.match(main, /fastDashboardPromptedVersion/);
  assert.match(main, /Vincular ao Dashboard FAST/);
  assert.match(main, /heartbeat\(open\)/);
  assert.match(main, /5 \* 60 \* 1000/);
});

test('Auxiliar de Anúncios integrado compila e mantém compatibilidade com o site FAST', { timeout: 30_000 }, () => {
  const helper = path.join(root, 'helper', 'clipboard-helper.ps1');
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', helper,
    '-ValidateOnly',
  ], { stdio: 'pipe' });
  const source = fs.readFileSync(helper, 'utf8');
  assert.match(source, /FAST_ANNOUNCEMENT_QUEUE_V1\|/);
  assert.match(source, /SetWindowsHookEx/);
  assert.match(source, /LlkhfInjected/);
});

test('aplicativo gerencia o auxiliar pela mesma bandeja', () => {
  const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  assert.match(main, /Ativar Auxiliar de Anúncios/);
  assert.match(main, /Cancelar sequência de anúncio/);
  assert.doesNotMatch(main, /por @guip1_/);
  assert.match(main, /notifyLocal\('FAST - Auxiliar de Anúncios'/);
  assert.doesNotMatch(main, /notify\('FAST - Auxiliar/);
  assert.match(main, /startClipboardHelper\(\)/);
  const pkg = require(path.join(root, 'package.json'));
  assert.equal(pkg.build.extraResources[0].to, 'helper');
});

test('ponte do Auxiliar de Anúncios inicia e encerra pelo canal interno', { timeout: 15_000 }, async (t) => {
  const helper = path.join(root, 'helper', 'clipboard-helper.ps1');
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', helper,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout aguardando auxiliar: ${output}`));
    }, 10_000);
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes('FAST_HELPER|READY')) child.stdin.write('stop\n');
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 10) {
        t.skip('a versão separada do auxiliar já está em execução');
        resolve();
      } else if (code !== 0) {
        reject(new Error(`auxiliar encerrou com código ${code}: ${output}`));
      } else {
        assert.match(output, /FAST_HELPER\|READY/);
        assert.match(output, /FAST_HELPER\|STATUS\|0\|0\|0\|/);
        resolve();
      }
    });
  });
});
