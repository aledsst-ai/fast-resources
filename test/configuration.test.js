const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
  assert.doesNotMatch(source, /Pol[ií]cia Capital/i);
});

test('emblema da North Police está incorporado ao pacote', () => {
  const icon = fs.readFileSync(path.join(root, 'assets', 'north-police.png'));
  assert.equal(icon.subarray(1, 4).toString('ascii'), 'PNG');
  const source = fs.readFileSync(path.join(root, 'src', 'core', 'phone-notify.js'), 'utf8');
  assert.match(source, /north-police\.png/);
  assert.match(source, /data:image\/png;base64/);
});

test('publicação aponta para o novo repositório', () => {
  const pkg = require(path.join(root, 'package.json'));
  assert.equal(pkg.version, '1.0.7');
  assert.deepEqual(pkg.build.publish[0], {
    provider: 'github',
    owner: 'aledsst-ai',
    repo: 'fast-resources',
  });
});
