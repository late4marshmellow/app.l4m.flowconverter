'use strict';

const Homey = require('homey');
const { HomeyAPIApp } = require('homey-api');

function redactSecrets(value) {
  const text = String(value || '');
  return text
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/ig, '$1[REDACTED]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+=*/g, '$1[REDACTED]')
    .replace(/(personal_api_token\s*[:=]\s*)[^\s,;]+/ig, '$1[REDACTED]')
    .replace(/([?&](?:token|api[_-]?key|authorization)=)[^&\s]+/ig, '$1[REDACTED]');
}

function safeErrorMessage(err) {
  const raw = err && err.message ? err.message : String(err || 'Unknown error');
  return redactSecrets(raw);
}

class FlowConverterApp extends Homey.App {
  async onInit() {
    this.log('FlowConverterApp is running');

    try {
      this.homeyApi = new HomeyAPIApp({ homey: this.homey });
      this.log('homeyApi created');
      await this._applyPersonalToken();
    } catch (err) {
      this.error(`Failed to create homeyApi: ${safeErrorMessage(err)}`);
    }

    // Inject app instance into API module for ManagerApi handler access.
    try {
      const api = require('./api');
      if (api && typeof api.setApp === 'function') {
        api.setApp(this);
      }
    } catch (e) {
      this.error(`Failed to set app on api module: ${safeErrorMessage(e)}`);
    }

    // Hot-reload personal token when user saves it in settings (no app restart needed).
    this.homey.settings.on('set', (key) => {
      if (key === 'personal_api_token') {
        this.log('personal_api_token changed — reapplying');
        this._applyPersonalToken().catch(err => this.error(`_applyPersonalToken failed: ${safeErrorMessage(err)}`));
      }
    });
  }

  // Injects personal token to homeyApi so flow writes are authorized.
  async _applyPersonalToken() {
    if (!this.homeyApi) {
      return;
    }
    try {
      const token = await this.homey.settings.get('personal_api_token');
      if (token) {
        // Trigger baseUrl discovery before injecting token.
        if (!this.homeyApi.__baseUrl) {
          try {
            await this.homeyApi.flow.getFlows();
          } catch (e) {}
        }
        this.homeyApi.__token = token;
        this.log('Personal API token applied to homeyApi');
      } else {
        this.log('No personal API token set — flow writes will fail with Missing Scopes');
      }
    } catch (err) {
      this.error(`_applyPersonalToken failed: ${safeErrorMessage(err)}`);
    }
  }
}

module.exports = FlowConverterApp;
