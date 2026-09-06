const { randomBytes } = require('node:crypto');
const ORIGIN = 'https://fastdivision.com.br';

class FastDashboard {
  constructor({ version, loadToken, saveToken, getOnDuty = () => false, fetchImpl = fetch }) {
    this.version = version;
    this.loadToken = loadToken;
    this.saveToken = saveToken;
    this.getOnDuty = getOnDuty;
    this.fetch = fetchImpl;
    this.busy = false;
    this.pendingHeartbeat = false;
    this.pendingDutyStatus = false;
  }

  async request(action, token, data = {}) {
    const response = await this.fetch(`${ORIGIN}/api/fast-app/${action}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ appVersion: this.version, ...data }),
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

  async heartbeat(onDuty = this.getOnDuty()) {
    this.pendingDutyStatus = onDuty === true;
    this.pendingHeartbeat = true;
    if (this.busy) return false;
    this.busy = true;
    let sent = false;
    try {
      const token = this.loadToken();
      if (!token) return false;
      while (this.pendingHeartbeat) {
        this.pendingHeartbeat = false;
        const dutyStatus = this.pendingDutyStatus;
        await this.request('heartbeat', token, { onDuty: dutyStatus });
        sent = true;
      }
      return sent;
    } catch { return false; }
    finally { this.busy = false; }
  }
}

module.exports = { FastDashboard, ORIGIN };
