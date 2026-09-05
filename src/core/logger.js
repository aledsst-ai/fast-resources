// Log central. Num app de bandeja não existe console pra ler, então tudo vai
// pra arquivo (aberto pelo menu "Ver logs") e pra um bus que a bandeja escuta.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const MAX_BUFFER_LINES = 500;
const ROTATE_BYTES = 5 * 1024 * 1024;

const bus = new EventEmitter();
const recent = [];
let stream = null;

// Chamado pelo processo principal, que é quem sabe o userData do Electron.
// Sem isso o log ainda funciona (console + memória), só não persiste.
function setLogFile(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > ROTATE_BYTES) {
      fs.rmSync(`${file}.old`, { force: true });
      fs.renameSync(file, `${file}.old`);
    }
    stream = fs.createWriteStream(file, { flags: 'a' });
    return file;
  } catch (err) {
    console.error(`Não consegui abrir o arquivo de log: ${err.message}`);
    return null;
  }
}

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  if (stream) stream.write(`${line}\n`);
  recent.push(line);
  if (recent.length > MAX_BUFFER_LINES) recent.shift();
  bus.emit('line', line);
}

module.exports = { log, bus, setLogFile, recent };
