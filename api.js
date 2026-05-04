'use strict';

// Allow app to inject its instance for reliable access.
let __APP_INSTANCE = null;

function getHomeyApi() {
  if (!__APP_INSTANCE) {
    throw new Error('App instance not initialized');
  }
  if (!__APP_INSTANCE.homeyApi) {
    throw new Error('homeyApi not available — personal API token may not be configured');
  }
  return __APP_INSTANCE.homeyApi;
}

module.exports = {
  async getDevices({ query } = {}) {
    try {
      const q = query && query.q ? String(query.q).toLowerCase().trim() : '';
      const limit = query && query.limit ? Math.max(1, parseInt(query.limit, 10) || 200) : 200;

      const homeyApi = getHomeyApi();
      const devicesObj = await homeyApi.devices.getDevices();
      let devices = Object.values(devicesObj || {});

      if (q) {
        devices = devices.filter(d => {
          const s = `${d.id} ${d.name || ''} ${d.driverId || ''}`.toLowerCase();
          return s.includes(q);
        });
      }

      return devices.slice(0, limit).map(d => ({ id: d.id, name: d.name }));
    } catch (err) {
      throw new Error(`Failed to fetch devices: ${  err && err.message ? err.message : String(err)}`);
    }
  },

  async getOrphanedDevices() {
    try {
      const homeyApi = getHomeyApi();
      const devicesObj = await homeyApi.devices.getDevices();
      const knownIds = new Set(Object.values(devicesObj || {}).map(d => d.id).filter(Boolean));

      const foundIds = new Map();

      function scanObj(obj, flowName) {
        const UUID_RE = /homey:device:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
        const str = JSON.stringify(obj);
        let m;
        while ((m = UUID_RE.exec(str)) !== null) {
          const uuid = m[1].toLowerCase();
          if (!foundIds.has(uuid)) {
            foundIds.set(uuid, new Set());
          }
          foundIds.get(uuid).add(flowName);
        }
      }

      const [flowsRaw, advancedRaw] = await Promise.all([
        homeyApi.flow.getFlows().catch(() => ({})),
        homeyApi.flow.getAdvancedFlows().catch(() => ({})),
      ]);

      for (const f of Object.values(flowsRaw || {})) {
        scanObj(f, f.name || f.id);
      }
      for (const af of Object.values(advancedRaw || {})) {
        scanObj(af, af.name || af.id);
      }

      const orphaned = [];
      for (const [uuid, flows] of foundIds.entries()) {
        if (!knownIds.has(uuid)) {
          orphaned.push({ id: uuid, flows: Array.from(flows) });
        }
      }
      orphaned.sort((a, b) => a.id.localeCompare(b.id));
      return orphaned;
    } catch (err) {
      throw new Error(`getOrphanedDevices failed: ${  err && err.message ? err.message : String(err)}`);
    }
  },

  async runConverter({ body } = {}) {
    try {
      const { oldIds, newIds, softRun } = body || {};
      const { runFlowConverter } = require('./flowconverter');
      const homeyApi = getHomeyApi();
      const result = await runFlowConverter({ Homey: homeyApi, oldIds: oldIds || [], newIds: newIds || [], softRun: !!softRun });
      return result;
    } catch (err) {
      throw new Error(`Converter failed: ${  err && err.message ? err.message : String(err)}`);
    }
  },
};

// Expose setter as non-enumerable so ManagerApi doesn't treat it as an HTTP endpoint.
Object.defineProperty(module.exports, 'setApp', {
  value(app) {
    __APP_INSTANCE = app;
  },
  enumerable: false,
  writable: true,
  configurable: true,
});
