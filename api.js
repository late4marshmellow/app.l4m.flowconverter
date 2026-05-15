'use strict';

// Allow app to inject its instance for reliable access.
let __APP_INSTANCE = null;

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

function getApp() {
  if (!__APP_INSTANCE) {
    throw new Error('App instance not initialized');
  }
  return __APP_INSTANCE;
}

function getHomeyApi() {
  if (!__APP_INSTANCE) {
    throw new Error('App instance not initialized');
  }
  if (!__APP_INSTANCE.homeyApi) {
    throw new Error('homeyApi not available — personal API token may not be configured');
  }
  return __APP_INSTANCE.homeyApi;
}

// Wrap a callback to load/decrypt the token for the duration of homeyApi calls.
async function withToken(callback) {
  const app = getApp();
  if (app._withDecryptedToken) {
    return await app._withDecryptedToken(callback);
  }
  // Fallback if method not available.
  return await callback();
}

function buildDeviceCapabilityMap(devicesObj) {
  const map = new Map();
  for (const d of Object.values(devicesObj || {})) {
    if (!d || !d.id) {
      continue;
    }
    const caps = new Set();
    if (Array.isArray(d.capabilities)) {
      d.capabilities.forEach(c => caps.add(String(c).toLowerCase()));
    }
    if (d.capabilitiesObj && typeof d.capabilitiesObj === 'object') {
      Object.keys(d.capabilitiesObj).forEach(c => caps.add(String(c).toLowerCase()));
    }
    map.set(String(d.id).toLowerCase(), caps);
  }
  return map;
}

function collectTokens(obj, maxMatches = 5000) {
  const tokenRegex = /homey:device:([0-9a-f-]{36})\|([a-z0-9_.\-]+)/gi;
  const matches = [];

  function walk(value) {
    if (matches.length >= maxMatches) {
      return;
    }
    if (typeof value === 'string') {
      tokenRegex.lastIndex = 0;
      let m;
      while ((m = tokenRegex.exec(value)) !== null) {
        matches.push({
          deviceId: String(m[1] || '').toLowerCase(),
          capability: String(m[2] || ''),
        });
        if (matches.length >= maxMatches) {
          break;
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(item => walk(item));
      return;
    }
    if (value && typeof value === 'object') {
      Object.keys(value).forEach(key => walk(value[key]));
    }
  }

  walk(obj);
  return matches;
}

function flowContainsDeviceRef(flowObj, deviceId) {
  const id = String(deviceId || '').toLowerCase().trim();
  if (!id) {
    return false;
  }
  const haystack = JSON.stringify(flowObj || {}).toLowerCase();
  return haystack.includes(`homey:device:${id}`);
}

module.exports = {
  async getDevices({ query } = {}) {
    try {
      const q = query && query.q ? String(query.q).toLowerCase().trim() : '';
      const limit = query && query.limit ? Math.max(1, parseInt(query.limit, 10) || 200) : 200;

      const devices = await withToken(async () => {
        const homeyApi = getHomeyApi();
        const devicesObj = await homeyApi.devices.getDevices();
        let devList = Object.values(devicesObj || {});

        if (q) {
          devList = devList.filter(d => {
            const s = `${d.id} ${d.name || ''} ${d.driverId || ''}`.toLowerCase();
            return s.includes(q);
          });
        }

        return devList.slice(0, limit).map(d => ({ id: d.id, name: d.name }));
      });

      return devices;
    } catch (err) {
      throw new Error(`Failed to fetch devices: ${safeErrorMessage(err)}`);
    }
  },

  async getOrphanedDevices() {
    try {
      const orphaned = await withToken(async () => {
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

        const result = [];
        for (const [uuid, flows] of foundIds.entries()) {
          if (!knownIds.has(uuid)) {
            result.push({ id: uuid, flows: Array.from(flows) });
          }
        }
        result.sort((a, b) => a.id.localeCompare(b.id));
        return result;
      });

      return orphaned;
    } catch (err) {
      throw new Error(`getOrphanedDevices failed: ${safeErrorMessage(err)}`);
    }
  },

  async getFlowList({ query } = {}) {
    try {
      const q = query && query.q ? String(query.q).toLowerCase().trim() : '';
      const limit = query && query.limit ? Math.max(1, parseInt(query.limit, 10) || 200) : 200;
      const oldId = query && query.oldId ? String(query.oldId).toLowerCase().trim() : '';
      const newId = query && query.newId ? String(query.newId).toLowerCase().trim() : '';

      const result = await withToken(async () => {
        const homeyApi = getHomeyApi();

        const [flowsRaw, advancedRaw] = await Promise.all([
          homeyApi.flow.getFlows().catch(() => ({})),
          homeyApi.flow.getAdvancedFlows().catch(() => ({})),
        ]);

        let flows = [
          ...Object.values(flowsRaw || {}).map(f => ({ id: f.id, name: f.name || f.id, type: 'flow', raw: f })),
          ...Object.values(advancedRaw || {}).map(f => ({ id: f.id, name: f.name || f.id, type: 'advanced', raw: f })),
        ];

        if (oldId || newId) {
          flows = flows.filter(f => {
            const hasOld = oldId ? flowContainsDeviceRef(f.raw, oldId) : false;
            const hasNew = newId ? flowContainsDeviceRef(f.raw, newId) : false;
            return hasOld || hasNew;
          });
        }

        if (q) {
          flows = flows.filter(f => `${f.id} ${f.name} ${f.type}`.toLowerCase().includes(q));
        }

        flows.sort((a, b) => a.name.localeCompare(b.name));
        return flows.slice(0, limit).map(f => ({ id: f.id, name: f.name, type: f.type }));
      });

      return result;
    } catch (err) {
      throw new Error(`Failed to fetch flows: ${safeErrorMessage(err)}`);
    }
  },

  async getFlowListNoSlash(args = {}) {
    return this.getFlowList(args);
  },

  async getCapabilityList({ query } = {}) {
    try {
      const q = query && query.q ? String(query.q).toLowerCase().trim() : '';
      const limit = query && query.limit ? Math.max(1, parseInt(query.limit, 10) || 200) : 200;
      const oldId = query && query.oldId ? String(query.oldId).toLowerCase().trim() : '';
      const newId = query && query.newId ? String(query.newId).toLowerCase().trim() : '';

      if (!oldId || !newId) {
        return [];
      }

      const result = await withToken(async () => {
        const homeyApi = getHomeyApi();
        const [devicesObj, flowsRaw, advancedRaw] = await Promise.all([
          homeyApi.devices.getDevices(),
          homeyApi.flow.getFlows().catch(() => ({})),
          homeyApi.flow.getAdvancedFlows().catch(() => ({})),
        ]);

        const capabilityMap = buildDeviceCapabilityMap(devicesObj || {});
        const newCaps = capabilityMap.get(newId);
        if (!newCaps) {
          return [];
        }

        const out = new Set();
        const sources = [
          ...Object.values(flowsRaw || {}),
          ...Object.values(advancedRaw || {}),
        ];

        for (const source of sources) {
          const tokens = collectTokens(source, 5000);
          for (const token of tokens) {
            if (token.deviceId !== oldId) {
              continue;
            }
            const { capability } = token;
            const capabilityNorm = String(capability || '').toLowerCase();
            const targetHasCapability = newCaps.has(capabilityNorm);
            if (targetHasCapability) {
              out.add(capability);
            }
          }
        }

        let capabilities = Array.from(out).sort((a, b) => a.localeCompare(b));
        if (q) {
          capabilities = capabilities.filter(c => c.toLowerCase().includes(q));
        }
        return capabilities.slice(0, limit).map(capability => ({ id: capability, name: capability }));
      });

      return result;
    } catch (err) {
      throw new Error(`Failed to fetch convertible capabilities: ${safeErrorMessage(err)}`);
    }
  },

  async getCapabilityDebug({ query } = {}) {
    try {
      const oldId = query && query.oldId ? String(query.oldId).toLowerCase().trim() : '';
      const newId = query && query.newId ? String(query.newId).toLowerCase().trim() : '';

      if (!oldId || !newId) {
        return {
          ok: false,
          reason: 'missing-old-or-new-id',
          oldId,
          newId,
        };
      }

      const result = await withToken(async () => {
        const homeyApi = getHomeyApi();
        const [devicesObj, flowsRaw, advancedRaw] = await Promise.all([
          homeyApi.devices.getDevices(),
          homeyApi.flow.getFlows().catch(() => ({})),
          homeyApi.flow.getAdvancedFlows().catch(() => ({})),
        ]);

        const capabilityMap = buildDeviceCapabilityMap(devicesObj || {});
        const oldCaps = capabilityMap.get(oldId) || new Set();
        const newCaps = capabilityMap.get(newId) || new Set();

        const sources = [
          ...Object.values(flowsRaw || {}),
          ...Object.values(advancedRaw || {}),
        ];

        const tokenCapsForOld = new Set();
        let tokenCountForOld = 0;
        let totalTokenCount = 0;

        for (const source of sources) {
          const tokens = collectTokens(source, 5000);
          totalTokenCount += tokens.length;
          for (const token of tokens) {
            if (token.deviceId !== oldId) {
              continue;
            }
            tokenCountForOld += 1;
            tokenCapsForOld.add(String(token.capability || ''));
          }
        }

        const intersection = Array.from(tokenCapsForOld).filter(c => newCaps.has(String(c).toLowerCase()));

        return {
          ok: true,
          oldId,
          newId,
          oldDeviceKnown: capabilityMap.has(oldId),
          newDeviceKnown: capabilityMap.has(newId),
          oldCapabilityCount: oldCaps.size,
          newCapabilityCount: newCaps.size,
          totalScannedFlows: sources.length,
          totalScannedTokens: totalTokenCount,
          tokenCountForOld,
          tokenCapabilityCountForOld: tokenCapsForOld.size,
          intersectionCount: intersection.length,
          sampleOldTokenCapabilities: Array.from(tokenCapsForOld).slice(0, 20),
          sampleNewCapabilities: Array.from(newCaps).slice(0, 20),
          sampleIntersection: intersection.slice(0, 20),
        };
      });

      return result;
    } catch (err) {
      return {
        ok: false,
        reason: 'exception',
        message: safeErrorMessage(err),
      };
    }
  },

  async getCapabilityDebugNoSlash(args = {}) {
    return this.getCapabilityDebug(args);
  },

  async getCapabilityListNoSlash(args = {}) {
    return this.getCapabilityList(args);
  },

  async runConverter({ body } = {}) {
    try {
      const {
        oldIds,
        newIds,
        softRun,
        flowIds,
        allowAmbiguousMerge,
        repairMode,
        capabilityFilters,
        allowClassMismatch,
      } = body || {};

      const result = await withToken(async () => {
        const { runFlowConverter } = require('./flowconverter');
        const homeyApi = getHomeyApi();
        return await runFlowConverter({
          Homey: homeyApi,
          oldIds: oldIds || [],
          newIds: newIds || [],
          flowIds: Array.isArray(flowIds) ? flowIds : [],
          repairMode: typeof repairMode === 'string' ? repairMode : 'standard',
          capabilityFilters: Array.isArray(capabilityFilters) ? capabilityFilters : [],
          allowClassMismatch: !!allowClassMismatch,
          allowAmbiguousMerge: !!allowAmbiguousMerge,
          softRun: !!softRun,
        });
      });

      return result;
    } catch (err) {
      throw new Error(`Converter failed: ${safeErrorMessage(err)}`);
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
