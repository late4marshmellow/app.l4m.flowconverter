'use strict';

// Replaces device references in flows and advanced flows.

function deepReplace(obj, oldId, newId) {
  let changed = false;
  let replacements = 0;
  function walk(value) {
    if (typeof value === 'string') {
      if (value.includes(oldId)) {
        const count = value.split(oldId).length - 1;
        replacements += count;
        changed = true;
        return value.replaceAll(oldId, newId);
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(v => walk(v));
    }
    if (value && typeof value === 'object') {
      const newObj = {};
      for (const key of Object.keys(value)) {
        newObj[key] = walk(value[key]);
      }
      return newObj;
    }
    return value;
  }
  const result = walk(obj);
  return { result, changed, replacements };
}

async function runFlowConverter({ Homey, oldIds: providedOldIds, newIds: providedNewIds, softRun }) {
  console.log('[flowconverter] start', { providedOldIds, providedNewIds, softRun: !!softRun });

  // Homey is always the homeyApi Web API client (HomeyAPIApp instance).
  const flowApi = Homey.flow;
  const devicesApi = Homey.devices;

  const devicesRaw = await devicesApi.getDevices();
  const allDevices = Object.values(devicesRaw || {});
  console.log('[flowconverter] devices loaded:', allDevices.length);

  let oldIds = Array.isArray(providedOldIds) && providedOldIds.length ? providedOldIds.slice() : [];
  let newIds = Array.isArray(providedNewIds) && providedNewIds.length ? providedNewIds.slice() : [];

  if (!oldIds.length) {
    throw new Error('No old device id provided');
  }

  if (!newIds.length) {
    throw new Error('No new device id provided');
  }

  console.log('[flowconverter] resolved IDs', { oldIds, newIds });

  const updatedFlows = [];
  const updatedAdvancedFlows = [];

  // Normal flows
  const flows = Object.values(await flowApi.getFlows() || {});
  console.log('[flowconverter] flows count:', flows.length);

  for (const f of flows) {
    let updatedFlow = JSON.parse(JSON.stringify(f));
    let flowChanged = false;
    let flowReplacements = 0;

    for (let i = 0; i < oldIds.length; i++) {
      const oldId = oldIds[i];
      const newId = newIds[i] || newIds[0];
      const { result, changed, replacements } = deepReplace(updatedFlow, oldId, newId);
      if (changed) {
        updatedFlow = result;
        flowChanged = true;
        flowReplacements += replacements;
        console.log('[flowconverter] flow', f.id, 'will change:', replacements, 'occurrence(s) of', oldId, '->', newId);
      }
    }

    if (flowChanged) {
      updatedFlows.push({ id: f.id, name: f.name || f.id, replacements: flowReplacements });
      if (!softRun) {
        try {
          // Send only the mutable sections — avoids sending read-only metadata fields.
          const partial = { id: updatedFlow.id, trigger: updatedFlow.trigger, conditions: updatedFlow.conditions, actions: updatedFlow.actions };
          await flowApi.updateFlow({ id: f.id, flow: partial });
          console.log('[flowconverter] updated flow', f.id);
        } catch (e) {
          console.error('[flowconverter] FAILED to update flow', f.id, e && e.message ? e.message : e);
        }
      }
    }
  }

  // Advanced flows
  const advancedFlows = Object.values(await flowApi.getAdvancedFlows() || {});
  console.log('[flowconverter] advanced flows count:', advancedFlows.length);

  for (const af of advancedFlows) {
    const updated = JSON.parse(JSON.stringify(af));
    let afChanged = false;
    let advReplacements = 0;

    for (let i = 0; i < oldIds.length; i++) {
      const oldId = oldIds[i];
      const newId = newIds[i] || newIds[0];
      const { result, changed, replacements } = deepReplace(updated.cards, oldId, newId);
      if (changed) {
        updated.cards = result;
        afChanged = true;
        advReplacements += replacements;
        console.log('[flowconverter] advanced flow', af.id, 'will change:', replacements, 'occurrence(s) of', oldId, '->', newId);
      }
    }

    if (afChanged) {
      updatedAdvancedFlows.push({ id: af.id, name: af.name || af.id, replacements: advReplacements });
      if (!softRun) {
        try {
          await flowApi.updateAdvancedFlow({ id: af.id, advancedflow: updated });
          console.log('[flowconverter] updated advanced flow', af.id);
        } catch (e) {
          console.error('[flowconverter] FAILED to update advanced flow', af.id, e && e.message ? e.message : e);
        }
      }
    }
  }

  console.log('[flowconverter] finished, totalUpdated:', updatedFlows.length + updatedAdvancedFlows.length);

  return {
    message: 'Finished updating flows',
    softRun: !!softRun,
    updatedFlows,
    updatedAdvancedFlows,
    totalUpdated: updatedFlows.length + updatedAdvancedFlows.length,
  };
}

module.exports = { runFlowConverter };
