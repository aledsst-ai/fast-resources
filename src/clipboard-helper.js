const { app } = require('electron');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { log } = require('./core/logger');

const STOP_TIMEOUT_MS = 3_000;

class ClipboardHelper extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.stopping = false;
    this.state = {
      running: false,
      ready: false,
      conflict: false,
      active: false,
      index: 0,
      count: 0,
      field: '',
      error: '',
    };
  }

  helperPath() {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'helper', 'clipboard-helper.ps1')
      : path.join(__dirname, '..', 'helper', 'clipboard-helper.ps1');
  }

  _setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  start() {
    if (this.child) return true;
    const script = this.helperPath();
    if (!fs.existsSync(script)) {
      const error = `Componente Ctrl+V não encontrado em ${script}`;
      log(error);
      this._setState({ running: false, ready: false, error });
      return false;
    }

    this.stopping = false;
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', script,
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this._setState({
      running: true,
      ready: false,
      conflict: false,
      active: false,
      index: 0,
      count: 0,
      field: '',
      error: '',
    });

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this._handleLine(line));
    child.stderr.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message) log(`Auxiliar Ctrl+V: ${message}`);
    });
    child.on('error', (err) => {
      log(`Auxiliar Ctrl+V não iniciou: ${err.message}`);
      this._setState({ running: false, ready: false, error: err.message });
    });
    child.on('exit', (code) => {
      lines.close();
      if (this.child === child) this.child = null;
      const conflict = code === 10;
      const unexpected = !this.stopping && !conflict;
      const error = unexpected ? `Componente encerrado (código ${code ?? 'desconhecido'})` : '';
      if (conflict) log('Outro Auxiliar Ctrl+V da FAST já está em execução.');
      else if (unexpected) log(`Auxiliar Ctrl+V encerrou inesperadamente (${code}).`);
      this._setState({
        running: false,
        ready: false,
        conflict,
        active: false,
        index: 0,
        count: 0,
        field: '',
        error,
      });
      this.emit('exit', { code, conflict, unexpected });
    });
    return true;
  }

  _handleLine(line) {
    if (!line.startsWith('FAST_HELPER|')) return;
    const parts = line.split('|');
    const type = parts[1];
    if (type === 'READY') {
      log('Auxiliar Ctrl+V integrado está pronto.');
      this._setState({ running: true, ready: true, conflict: false, error: '' });
      return;
    }
    if (type === 'CONFLICT') {
      this._setState({ running: false, ready: false, conflict: true, error: '' });
      return;
    }
    if (type === 'ERROR') {
      const error = parts.slice(2).join('|') || 'Erro desconhecido';
      log(`Auxiliar Ctrl+V: ${error}`);
      this._setState({ error });
      this.emit('helper-error', error);
      return;
    }
    if (type === 'STATUS') {
      this._setState({
        active: parts[2] === '1',
        index: Number(parts[3]) || 0,
        count: Number(parts[4]) || 0,
        field: parts[5] || '',
      });
      return;
    }
    if (type === 'EVENT') {
      this.emit('helper-event', {
        name: parts[2] || '',
        count: Number(parts[3]) || 0,
      });
    }
  }

  send(command) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) return false;
    try {
      this.child.stdin.write(`${command}\n`);
      return true;
    } catch {
      return false;
    }
  }

  cancel() {
    return this.send('cancel');
  }

  stop() {
    if (!this.child) return Promise.resolve();
    this.stopping = true;
    const child = this.child;
    return new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        resolve();
      };
      child.once('exit', done);
      this.send('stop');
      setTimeout(() => {
        if (this.child === child) {
          try { child.kill(); } catch {}
        }
        done();
      }, STOP_TIMEOUT_MS);
    });
  }

  stopNow() {
    this.stopping = true;
    if (!this.child) return;
    try { this.child.kill(); } catch {}
  }
}

module.exports = { ClipboardHelper };
