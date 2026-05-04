'use strict';

const Homey = require('homey');
const { HomeyAPIApp } = require('homey-api');

class FlowConverterApp extends Homey.App {
  async onInit() {
    this.log('FlowConverterApp is running');

    try {
      this.homeyApi = new HomeyAPIApp({ homey: this.homey });
      this.log('homeyApi created');
      await this._applyPersonalToken();
    } catch (err) {
      this.error('Failed to create homeyApi', err);
    }

    // Inject app instance into API module for ManagerApi handler access.
    try {
      const api = require('./api');
      if (api && typeof api.setApp === 'function') {
        api.setApp(this);
      }
    } catch (e) {
      this.error('Failed to set app on api module', e);
    }

    // Hot-reload personal token when user saves it in settings (no app restart needed).
    this.homey.settings.on('set', (key) => {
      if (key === 'personal_api_token') {
        this.log('personal_api_token changed — reapplying');
        this._applyPersonalToken().catch(err => this.error('_applyPersonalToken failed', err));
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
        this.log(`Personal API token applied to homeyApi (length: ${  token.length  })`);
      } else {
        this.log('No personal API token set — flow writes will fail with Missing Scopes');
      }
    } catch (err) {
      this.error('_applyPersonalToken failed', err);
    }
  }
}

module.exports = FlowConverterApp;
