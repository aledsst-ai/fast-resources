const { randomBytes } = require('node:crypto');
const ORIGIN = 'https://fastdivision.com.br';

class FastDashboard {
  constructor({ version, loadToken, saveToken, fetchImpl = fetch }) {
    this.version = version;
    this.loadToken = loadToken;
    this.saveToken = saveToken;
    this.fetch = fetchImpl;
    this.busy = false;
  }

  async request(action, token) {
    const response = await this.fetch(`${ORIGIN}/api/fast-app/${action}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ appVersion: this.version }),
    });
    if (!response.ok) throw new Error(`dashboard_${response.status}`);
    return response.json();
  }

  async pair() {
    let token = this.loadToken();
    if (!token) {
      token = `fast_app_${randomBytes(32).toString('hex')}`;
      this.saveToken(token);
    }
    return this.request('pairings', token);
  }

  async heartbeat() {
    if (this.busy) return false;
    this.busy = true;
    try {
      const token = this.loadToken();
      if (!token) return false;
      await this.request('heartbeat', token);
      return true;
    } catch { return false; }
    finally { this.busy = false; }
  }
}

module.exports = { FastDashboard, ORIGIN };
