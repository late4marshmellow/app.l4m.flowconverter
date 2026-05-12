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

function buildDeviceCapabilityMap(devices) {
  const out = new Map();
  for (const d of devices || []) {
    if (!d || !d.id) {
      continue;
    }
    const caps = new Set();
    if (Array.isArray(d.capabilities)) {
      d.capabilities.forEach(c => caps.add(String(c)));
    }
    if (d.capabilitiesObj && typeof d.capabilitiesObj === 'object') {
      Object.keys(d.capabilitiesObj).forEach(c => caps.add(String(c)));
    }
    out.set(String(d.id).toLowerCase(), caps);
  }
  return out;
}

function replaceBrokenDeviceTokens(obj, oldId, newId, deviceCapabilityMap, capabilityFilterSet) {
  const oldIdStr = String(oldId || '').toLowerCase();
  const newIdStr = String(newId || '').toLowerCase();
  if (!oldIdStr || !newIdStr || oldIdStr === newIdStr) {
    return { changed: false, replacements: 0, result: obj };
  }

  const tokenRegex = /homey:device:([0-9a-f-]{36})\|([a-z0-9_.\-]+)/gi;
  const oldCaps = deviceCapabilityMap.get(oldIdStr);
  const newCaps = deviceCapabilityMap.get(newIdStr);

  let changed = false;
  let replacements = 0;

  function walk(value) {
    if (typeof value === 'string') {
      tokenRegex.lastIndex = 0;
      let localChanges = 0;
      const replaced = value.replace(tokenRegex, (full, deviceId, capability) => {
        const sourceId = String(deviceId || '').toLowerCase();
        if (sourceId !== oldIdStr.toLowerCase()) {
          return full;
        }

        const capabilityId = String(capability || '');
        if (capabilityFilterSet && capabilityFilterSet.size && !capabilityFilterSet.has(capabilityId)) {
          return full;
        }

        const isBroken = !oldCaps || !oldCaps.has(capabilityId);
        const targetSupportsCapability = !!newCaps && newCaps.has(capabilityId);
        if (!isBroken) {
          return full;
        }
        if (!targetSupportsCapability) {
          return full;
        }

        localChanges += 1;
        return `homey:device:${newIdStr}|${capabilityId}`;
      });

      if (localChanges > 0) {
        changed = true;
        replacements += localChanges;
        return replaced;
      }
      return value;
    }

    if (Array.isArray(value)) {
      return value.map(v => walk(v));
    }

    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value)) {
        out[key] = walk(value[key]);
      }
      return out;
    }

    return value;
  }

  const result = walk(obj);
  return { changed, replacements, variableTokenReplacements: replacements, result };
}

function collectDeviceTokens(obj, options = {}) {
  const tokenRegex = /homey:device:([0-9a-f-]{36})\|([a-z0-9_.\-]+)/gi;
  const matches = [];
  const maxMatches = typeof options.maxMatches === 'number' ? options.maxMatches : 100;

  function walk(value, path) {
    if (matches.length >= maxMatches) {
      return;
    }
    if (typeof value === 'string') {
      tokenRegex.lastIndex = 0;
      let m;
      while ((m = tokenRegex.exec(value)) !== null) {
        matches.push({
          token: m[0],
          deviceId: String(m[1] || '').toLowerCase(),
          capability: String(m[2] || ''),
          path,
        });
        if (matches.length >= maxMatches) {
          break;
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === 'object') {
      Object.keys(value).forEach(key => walk(value[key], path ? `${path}.${key}` : key));
    }
  }

  walk(obj, '');
  return matches;
}

function buildCardIdentitySet(items) {
  const set = new Set();
  for (const item of items || []) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    if (item.id) {
      set.add(String(item.id));
    }
    if (item.uri && item.id) {
      set.add(`${item.uri}:${item.id}`);
    }
  }
  return set;
}

async function getAvailabilityMap(flowApi) {
  try {
    const [triggersRaw, conditionsRaw, actionsRaw] = await Promise.all([
      flowApi.getFlowCardTriggers().catch(() => ({})),
      flowApi.getFlowCardConditions().catch(() => ({})),
      flowApi.getFlowCardActions().catch(() => ({})),
    ]);

    const triggers = Object.values(triggersRaw || {});
    const conditions = Object.values(conditionsRaw || {});
    const actions = Object.values(actionsRaw || {});

    return {
      supported: true,
      trigger: buildCardIdentitySet(triggers),
      condition: buildCardIdentitySet(conditions),
      action: buildCardIdentitySet(actions),
    };
  } catch (err) {
    console.warn('[flowconverter] failed to build availability map:', err && err.message ? err.message : err);
    return {
      supported: false,
      trigger: new Set(),
      condition: new Set(),
      action: new Set(),
    };
  }
}

function isUnavailableCard(card, cardType, availabilityMap) {
  if (!availabilityMap || !availabilityMap.supported) {
    return false;
  }
  if (!card || typeof card !== 'object') {
    return false;
  }

  const type = cardType === 'condition' ? 'condition' : cardType === 'action' ? 'action' : 'trigger';
  const known = availabilityMap[type] || new Set();

  const id = card.id ? String(card.id) : '';
  const uri = card.uri ? String(card.uri) : '';
  const composite = uri && id ? `${uri}:${id}` : '';

  if (!id && !composite) {
    return false;
  }

  if (known.has(id) || (composite && known.has(composite))) {
    return false;
  }

  return true;
}

function replaceInFlowCardsSelective(flow, oldId, newId, {
  onlyUnavailableCards,
  availabilityMap,
  onlyBrokenVariables,
  deviceCapabilityMap,
  capabilityFilterSet,
}) {
  let changed = false;
  let replacements = 0;
  let variableTokenReplacements = 0;

  const shouldProcess = (card, cardType) => {
    if (!onlyUnavailableCards) {
      return true;
    }
    return isUnavailableCard(card, cardType, availabilityMap);
  };

  if (flow.trigger && typeof flow.trigger === 'object' && shouldProcess(flow.trigger, 'trigger')) {
    const r = onlyBrokenVariables
      ? replaceBrokenDeviceTokens(flow.trigger, oldId, newId, deviceCapabilityMap, capabilityFilterSet)
      : deepReplace(flow.trigger, oldId, newId);
    if (r.changed) {
      flow.trigger = r.result;
      changed = true;
      replacements += r.replacements;
      variableTokenReplacements += r.variableTokenReplacements || 0;
    }
  }

  const sections = [
    { key: 'conditions', type: 'condition' },
    { key: 'actions', type: 'action' },
  ];

  for (const section of sections) {
    if (!Array.isArray(flow[section.key])) {
      continue;
    }
    flow[section.key] = flow[section.key].map(card => {
      if (!shouldProcess(card, section.type)) {
        return card;
      }
      const r = onlyBrokenVariables
        ? replaceBrokenDeviceTokens(card, oldId, newId, deviceCapabilityMap, capabilityFilterSet)
        : deepReplace(card, oldId, newId);
      if (r.changed) {
        changed = true;
        replacements += r.replacements;
        variableTokenReplacements += r.variableTokenReplacements || 0;
        return r.result;
      }
      return card;
    });
  }

  return { changed, replacements, variableTokenReplacements, result: flow };
}

function replaceInAdvancedCardsSelective(cards, oldId, newId, {
  onlyUnavailableCards,
  availabilityMap,
  onlyBrokenVariables,
  deviceCapabilityMap,
  capabilityFilterSet,
}) {
  let changed = false;
  let replacements = 0;
  let variableTokenReplacements = 0;
  const out = { ...(cards || {}) };

  for (const key of Object.keys(out)) {
    const card = out[key];
    const cardType = card && card.type ? String(card.type) : 'action';
    if (onlyUnavailableCards && !isUnavailableCard(card, cardType, availabilityMap)) {
      continue;
    }

    const r = onlyBrokenVariables
      ? replaceBrokenDeviceTokens(card, oldId, newId, deviceCapabilityMap, capabilityFilterSet)
      : deepReplace(card, oldId, newId);
    if (r.changed) {
      out[key] = r.result;
      changed = true;
      replacements += r.replacements;
      variableTokenReplacements += r.variableTokenReplacements || 0;
    }
  }

  return { changed, replacements, variableTokenReplacements, result: out };
}

function hasIdReference(obj, id) {
  if (!id) {
    return false;
  }
  const needle = String(id);
  let found = false;

  function walk(value) {
    if (found) {
      return;
    }
    if (typeof value === 'string') {
      if (value.includes(needle)) {
        found = true;
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
        if (found) {
          return;
        }
      }
      return;
    }
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        walk(value[key]);
        if (found) {
          return;
        }
      }
    }
  }

  walk(obj);
  return found;
}

async function runFlowConverter({
  Homey,
  oldIds: providedOldIds,
  newIds: providedNewIds,
  softRun,
  flowIds: providedFlowIds,
  allowAmbiguousMerge,
  repairMode,
  capabilityFilters: providedCapabilityFilters,
  allowClassMismatch,
}) {
  console.log('[flowconverter] start', {
    providedOldIds,
    providedNewIds,
    softRun: !!softRun,
    providedFlowIds,
    allowAmbiguousMerge: !!allowAmbiguousMerge,
    repairMode,
    providedCapabilityFilters,
    allowClassMismatch: !!allowClassMismatch,
  });

  // Homey is always the homeyApi Web API client (HomeyAPIApp instance).
  const flowApi = Homey.flow;
  const devicesApi = Homey.devices;

  const devicesRaw = await devicesApi.getDevices();
  const allDevices = Object.values(devicesRaw || {});
  console.log('[flowconverter] devices loaded:', allDevices.length);

  const oldIds = Array.isArray(providedOldIds) && providedOldIds.length ? providedOldIds.slice() : [];
  const newIds = Array.isArray(providedNewIds) && providedNewIds.length ? providedNewIds.slice() : [];
  const flowIds = Array.isArray(providedFlowIds) && providedFlowIds.length
    ? providedFlowIds.map(id => String(id).trim()).filter(Boolean)
    : [];
  const mode = ['standard', 'unavailable', 'broken'].includes(String(repairMode || ''))
    ? String(repairMode)
    : 'standard';
  const unavailableOnly = mode === 'unavailable';
  const brokenVariablesOnly = mode === 'broken';
  const capabilityFilters = Array.isArray(providedCapabilityFilters) && providedCapabilityFilters.length
    ? providedCapabilityFilters.map(f => String(f).trim()).filter(Boolean)
    : [];
  const capabilityFilterSet = capabilityFilters.length ? new Set(capabilityFilters) : null;
  const classMismatchAllowed = !!allowClassMismatch;
  const flowScope = flowIds.length ? new Set(flowIds) : null;

  if (!oldIds.length) {
    throw new Error('No old device id provided');
  }

  if (!newIds.length) {
    throw new Error('No new device id provided');
  }

  for (let i = 0; i < oldIds.length; i++) {
    const oldIdNorm = String(oldIds[i] || '').trim().toLowerCase();
    const newIdNorm = String((newIds[i] || newIds[0] || '')).trim().toLowerCase();
    if (!oldIdNorm || !newIdNorm) {
      continue;
    }
    if (oldIdNorm === newIdNorm) {
      throw new Error(`Source and target device IDs are identical for pair ${i + 1}: ${oldIds[i]} -> ${newIds[i] || newIds[0]}. Select a different target device.`);
    }
  }

  console.log('[flowconverter] resolved IDs', {
    oldIds,
    newIds,
    flowIds,
    mode,
    capabilityFilters,
    unavailableOnly,
    brokenVariablesOnly,
    classMismatchAllowed,
  });

  const deviceById = new Map(allDevices.map(d => [String(d.id).toLowerCase(), d]));
  const classMismatchPairs = [];
  for (let i = 0; i < oldIds.length; i++) {
    const oldId = oldIds[i];
    const newId = newIds[i] || newIds[0];
    const oldDevice = deviceById.get(String(oldId).toLowerCase());
    const newDevice = deviceById.get(String(newId).toLowerCase());
    if (!oldDevice || !newDevice) {
      continue;
    }
    const oldClass = oldDevice.class ? String(oldDevice.class) : '';
    const newClass = newDevice.class ? String(newDevice.class) : '';
    if (oldClass && newClass && oldClass !== newClass) {
      classMismatchPairs.push({ oldId, newId, oldClass, newClass });
    }
  }
  if (classMismatchPairs.length && !classMismatchAllowed && !brokenVariablesOnly) {
    const first = classMismatchPairs[0];
    throw new Error(`Class mismatch guard: ${first.oldClass} -> ${first.newClass}. Enable override to continue.`);
  }

  const deviceCapabilityMap = brokenVariablesOnly ? buildDeviceCapabilityMap(allDevices) : new Map();

  const availabilityMap = unavailableOnly ? await getAvailabilityMap(flowApi) : { supported: false };
  if (unavailableOnly && !availabilityMap.supported) {
    throw new Error('Unavailable-card mode is not supported on this Homey API version');
  }

  const updatedFlows = [];
  const updatedAdvancedFlows = [];
  const ambiguousFlows = [];
  let totalVariableTokenReplacements = 0;
  const debugTokenMatches = [];

  // Normal flows
  const flows = Object.values(await flowApi.getFlows() || {});
  console.log('[flowconverter] flows count:', flows.length);

  for (const f of flows) {
    if (flowScope && !flowScope.has(f.id)) {
      continue;
    }

    let isAmbiguous = false;
    for (let i = 0; i < oldIds.length; i++) {
      const oldId = oldIds[i];
      const newId = newIds[i] || newIds[0];
      if (!oldId || !newId || oldId === newId) {
        continue;
      }
      if (hasIdReference(f, oldId) && hasIdReference(f, newId)) {
        isAmbiguous = true;
        break;
      }
    }
    if (isAmbiguous && allowAmbiguousMerge) {
      ambiguousFlows.push({ id: f.id, name: f.name || f.id, type: 'flow' });
      console.warn('[flowconverter] ambiguous flow', f.id, '- contains both source and target IDs');
    }

    let updatedFlow = JSON.parse(JSON.stringify(f));
    let flowChanged = false;
    let flowReplacements = 0;
    let flowVariableTokenReplacements = 0;

    if (brokenVariablesOnly) {
      const foundTokens = collectDeviceTokens(updatedFlow, { maxMatches: 50 });
      const matchingTokens = [];
      for (const tokenInfo of foundTokens) {
        for (let i = 0; i < oldIds.length; i++) {
          const oldId = String(oldIds[i] || '').toLowerCase();
          const newId = String(newIds[i] || newIds[0] || '').toLowerCase();
          const oldCaps = deviceCapabilityMap.get(oldId);
          const newCaps = deviceCapabilityMap.get(newId);
          const sourceBroken = !oldCaps || !oldCaps.has(tokenInfo.capability);
          const targetHasCapability = !!newCaps && newCaps.has(tokenInfo.capability);
          if (tokenInfo.deviceId === oldId) {
            matchingTokens.push({
              token: tokenInfo.token,
              capability: tokenInfo.capability,
              path: tokenInfo.path,
              sourceBroken,
              targetHasCapability,
            });
          }
        }
      }
      if (matchingTokens.length) {
        debugTokenMatches.push({
          flowId: f.id,
          flowName: f.name || f.id,
          type: 'flow',
          matches: matchingTokens,
        });
      }
    }

    for (let i = 0; i < oldIds.length; i++) {
      const oldId = oldIds[i];
      const newId = newIds[i] || newIds[0];
      const selectiveMode = unavailableOnly || brokenVariablesOnly;
      const { result, changed, replacements, variableTokenReplacements } = selectiveMode
        ? replaceInFlowCardsSelective(updatedFlow, oldId, newId, {
          onlyUnavailableCards: unavailableOnly,
          availabilityMap,
          onlyBrokenVariables: brokenVariablesOnly,
          deviceCapabilityMap,
          capabilityFilterSet,
        })
        : deepReplace(updatedFlow, oldId, newId);
      if (changed) {
        updatedFlow = result;
        flowChanged = true;
        flowReplacements += replacements;
        flowVariableTokenReplacements += variableTokenReplacements || 0;
        console.log('[flowconverter] flow', f.id, 'will change:', replacements, 'occurrence(s) of', oldId, '->', newId);
      }
    }

    if (flowChanged) {
      totalVariableTokenReplacements += flowVariableTokenReplacements;
      updatedFlows.push({
        id: f.id,
        name: f.name || f.id,
        replacements: flowReplacements,
        variableTokenReplacements: flowVariableTokenReplacements,
      });
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
    if (flowScope && !flowScope.has(af.id)) {
      continue;
    }

    let isAmbiguous = false;
    for (let i = 0; i < oldIds.length; i++) {
      const oldId = oldIds[i];
      const newId = newIds[i] || newIds[0];
      if (!oldId || !newId || oldId === newId) {
        continue;
      }
      if (hasIdReference(af, oldId) && hasIdReference(af, newId)) {
        isAmbiguous = true;
        break;
      }
    }
    if (isAmbiguous && allowAmbiguousMerge) {
      ambiguousFlows.push({ id: af.id, name: af.name || af.id, type: 'advanced' });
      console.warn('[flowconverter] ambiguous advanced flow', af.id, '- contains both source and target IDs');
    }

    const updated = JSON.parse(JSON.stringify(af));
    let afChanged = false;
    let advReplacements = 0;
    let advVariableTokenReplacements = 0;

    if (brokenVariablesOnly) {
      const foundTokens = collectDeviceTokens(updated.cards, { maxMatches: 50 });
      const matchingTokens = [];
      for (const tokenInfo of foundTokens) {
        for (let i = 0; i < oldIds.length; i++) {
          const oldId = String(oldIds[i] || '').toLowerCase();
          const newId = String(newIds[i] || newIds[0] || '').toLowerCase();
          const oldCaps = deviceCapabilityMap.get(oldId);
          const newCaps = deviceCapabilityMap.get(newId);
          const sourceBroken = !oldCaps || !oldCaps.has(tokenInfo.capability);
          const targetHasCapability = !!newCaps && newCaps.has(tokenInfo.capability);
          if (tokenInfo.deviceId === oldId) {
            matchingTokens.push({
              token: tokenInfo.token,
              capability: tokenInfo.capability,
              path: tokenInfo.path,
              sourceBroken,
              targetHasCapability,
            });
          }
        }
      }
      if (matchingTokens.length) {
        debugTokenMatches.push({
          flowId: af.id,
          flowName: af.name || af.id,
          type: 'advanced',
          matches: matchingTokens,
        });
      }
    }

    for (let i = 0; i < oldIds.length; i++) {
      const oldId = oldIds[i];
      const newId = newIds[i] || newIds[0];
      const selectiveMode = unavailableOnly || brokenVariablesOnly;
      const { result, changed, replacements, variableTokenReplacements } = selectiveMode
        ? replaceInAdvancedCardsSelective(updated.cards, oldId, newId, {
          onlyUnavailableCards: unavailableOnly,
          availabilityMap,
          onlyBrokenVariables: brokenVariablesOnly,
          deviceCapabilityMap,
          capabilityFilterSet,
        })
        : deepReplace(updated.cards, oldId, newId);
      if (changed) {
        updated.cards = result;
        afChanged = true;
        advReplacements += replacements;
        advVariableTokenReplacements += variableTokenReplacements || 0;
        console.log('[flowconverter] advanced flow', af.id, 'will change:', replacements, 'occurrence(s) of', oldId, '->', newId);
      }
    }

    if (afChanged) {
      totalVariableTokenReplacements += advVariableTokenReplacements;
      updatedAdvancedFlows.push({
        id: af.id,
        name: af.name || af.id,
        replacements: advReplacements,
        variableTokenReplacements: advVariableTokenReplacements,
      });
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
    scopedToFlowIds: flowIds,
    repairMode: mode,
    capabilityFilters,
    onlyUnavailableCards: unavailableOnly,
    onlyBrokenVariables: brokenVariablesOnly,
    totalVariableTokenReplacements,
    debugTokenMatches,
    classMismatchPairs,
    classGuardBypassedForBrokenVariables: classMismatchPairs.length > 0 && brokenVariablesOnly && !classMismatchAllowed,
    allowClassMismatch: classMismatchAllowed,
    allowAmbiguousMerge: !!allowAmbiguousMerge,
    ambiguousFlows,
    updatedFlows,
    updatedAdvancedFlows,
    totalUpdated: updatedFlows.length + updatedAdvancedFlows.length,
  };
}

module.exports = { runFlowConverter };
