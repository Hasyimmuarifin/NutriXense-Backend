const { admin, db } = require('./firebase');
const { config } = require('./config');

const RELAY_LABELS = {
  1: 'Pompa A (N)',
  2: 'Pompa B (P)',
  3: 'Pompa C (K)',
  4: 'Pompa D (Air)',
};

const RELAY_CONFIRMATION_TIMEOUT_MS = 5000;

function validRelays(relays) {
  return [...new Set(relays.map(Number))]
    .filter((relay) => Number.isInteger(relay) && relay >= 1 && relay <= 4)
    .sort((a, b) => a - b);
}

function publishExclusiveRelay(client, activeRelay) {
  const payload = JSON.stringify({
    source: 'manual_control',
    manual_override: 1,
    relay1: activeRelay === 1 ? 1 : 0,
    relay2: activeRelay === 2 ? 1 : 0,
    relay3: activeRelay === 3 ? 1 : 0,
    relay4: activeRelay === 4 ? 1 : 0,
  });
  client.publish(config.mqtt.controlTopic, payload, { qos: 1 }, (error) => {
    if (error) {
      console.error(`Failed to publish exclusive relay ${activeRelay} command:`, error);
      return;
    }

    console.log(`Published exclusive payload ${payload} to ${config.mqtt.controlTopic}`);
  });
}

function publishAllRelaysOff(client) {
  const payload = JSON.stringify({
    source: 'manual_control',
    manual_override: 0,
    relay1: 0,
    relay2: 0,
    relay3: 0,
    relay4: 0,
  });
  client.publish(config.mqtt.controlTopic, payload, { qos: 1 }, (error) => {
    if (error) {
      console.error('Failed to publish all relays off command:', error);
      return;
    }

    console.log(`Published all relays OFF payload ${payload} to ${config.mqtt.controlTopic}`);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function relayStateFromPayload(payload, relay) {
  const rawValue = payload[`relay${relay}`];
  if (rawValue === undefined || rawValue === null) return undefined;

  const parsedValue = typeof rawValue === 'number'
    ? rawValue
    : Number(rawValue);
  if (!Number.isFinite(parsedValue)) return undefined;

  return parsedValue === 1;
}

function waitForRelayStates(client, relays, expectedState, timeoutMs = RELAY_CONFIRMATION_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const remaining = new Set(relays);
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.removeListener('message', onMessage);
      resolve(false);
    }, timeoutMs);

    function onMessage(topic, rawPayload) {
      if (topic !== config.mqtt.sensorTopic || settled) return;

      try {
        const payload = JSON.parse(rawPayload.toString('utf8'));
        for (const relay of [...remaining]) {
          const actualState = relayStateFromPayload(payload, relay);
          if (actualState === expectedState) {
            remaining.delete(relay);
          }
        }

        if (remaining.size === 0) {
          settled = true;
          clearTimeout(timer);
          client.removeListener('message', onMessage);
          resolve(true);
        }
      } catch (_) {}
    }

    client.on('message', onMessage);
  });
}

async function runPumpPulse(client, relays, durationMs, reason, metadata = {}) {
  const selectedRelays = validRelays(relays);
  if (selectedRelays.length === 0) return;

  const startedAt = new Date();

  try {
    for (let i = 0; i < selectedRelays.length; i++) {
      const relay = selectedRelays[i];

      publishExclusiveRelay(client, relay);
      await delay(durationMs);
      publishAllRelaysOff(client);

      if (i < selectedRelays.length - 1) {
        await delay(3000);
      }
    }
  } finally {
    publishAllRelaysOff(client);

    await db.collection(config.firestore.pumpLogsCollection).add({
      relays: selectedRelays,
      pumpLabels: selectedRelays.map((relay) => RELAY_LABELS[relay]),
      durationMs: durationMs * selectedRelays.length,
      activationMode: 'sequential_optimistic',
      reason,
      metadata,
      startedAt,
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

async function runPumpPulseByRelay(client, durationMsByRelay, reason, metadata = {}) {
  const entries = Object.entries(durationMsByRelay || {})
    .map(([relay, durationMs]) => [Number(relay), Number(durationMs)])
    .filter(([relay, durationMs]) =>
      Number.isInteger(relay) &&
      relay >= 1 &&
      relay <= 4 &&
      Number.isFinite(durationMs) &&
      durationMs > 0,
    )
    .sort(([relayA], [relayB]) => relayA - relayB);

  if (entries.length === 0) return;

  const selectedRelays = entries.map(([relay]) => relay);
  const durationByRelay = Object.fromEntries(entries);
  const totalDurationMs = entries.reduce((sum, [, ms]) => sum + ms, 0);

  const startedAt = new Date();

  try {
    for (let i = 0; i < entries.length; i++) {
      const [relay, durationMs] = entries[i];

      publishExclusiveRelay(client, relay);
      await delay(durationMs);
      publishAllRelaysOff(client);

      if (i < entries.length - 1) {
        await delay(3000);
      }
    }
  } finally {
    publishAllRelaysOff(client);

    await db.collection(config.firestore.pumpLogsCollection).add({
      relays: selectedRelays,
      pumpLabels: selectedRelays.map((relay) => RELAY_LABELS[relay]),
      durationMs: totalDurationMs,
      durationMsByRelay: durationByRelay,
      activationMode: 'sequential_optimistic',
      reason,
      metadata,
      startedAt,
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

module.exports = {
  RELAY_LABELS,
  runPumpPulse,
  runPumpPulseByRelay,
  validRelays,
};
