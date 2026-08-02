const mqtt = require('mqtt');
const { admin, db } = require('./firebase');
const { config } = require('./config');
const { normalizeSensorPayload } = require('./sensorNormalizer');
const { RELAY_LABELS } = require('./pumpController');

let lastSavedTime = 0;
const manualPumpSessions = new Map();
const pendingManualPumpCommands = new Map();
const MANUAL_COMMAND_CONFIRM_TIMEOUT_MS = 15 * 1000;

function parsePayload(rawPayload) {
  const message = rawPayload.toString('utf8');
  return JSON.parse(message);
}

function timestampFromLocalParts(year, month, day, hour, minute, second) {
  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second);
  const checkDate = new Date(utcMillis);

  if (
    checkDate.getUTCFullYear() !== year ||
    checkDate.getUTCMonth() !== month - 1 ||
    checkDate.getUTCDate() !== day ||
    checkDate.getUTCHours() !== hour ||
    checkDate.getUTCMinutes() !== minute ||
    checkDate.getUTCSeconds() !== second
  ) {
    return undefined;
  }

  const deviceUtcMillis =
    utcMillis - config.automation.timezoneOffsetMinutes * 60 * 1000;
  return admin.firestore.Timestamp.fromDate(new Date(deviceUtcMillis));
}

function timestampFromDeviceString(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;

  const trimmed = value.trim();
  const localMatch = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/,
  );

  if (localMatch) {
    const [, year, month, day, hour, minute, second] = localMatch;
    return timestampFromLocalParts(
      Number(year),
      Number(month),
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    );
  }

  const parsedMillis = Date.parse(trimmed);
  if (!Number.isFinite(parsedMillis)) return undefined;

  return admin.firestore.Timestamp.fromDate(new Date(parsedMillis));
}

function timestampFromRtc(payload) {
  const rtc = payload.rtc;
  if (!rtc || typeof rtc !== 'object') return undefined;

  const year = Number(rtc.year);
  const month = Number(rtc.month);
  const day = Number(rtc.day);
  const hour = Number(rtc.hour);
  const minute = Number(rtc.minute);
  const second = Number(rtc.second || 0);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second)
  ) {
    return undefined;
  }

  return timestampFromLocalParts(year, month, day, hour, minute, second);
}

function readPayloadTimestamp(payload) {
  const rawTimestamp = payload.timestamp;

  if (typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp)) {
    const millis = rawTimestamp < 10000000000
      ? rawTimestamp * 1000
      : rawTimestamp;
    return admin.firestore.Timestamp.fromMillis(millis);
  }

  return timestampFromDeviceString(rawTimestamp) || timestampFromRtc(payload);
}

async function saveSensorReading(topic, payload, options = {}) {
  const {
    respectSaveInterval = true,
    usePayloadTimestamp = false,
    source = 'hivemq',
  } = options;
  const now = Date.now();
  if (
    respectSaveInterval &&
    now - lastSavedTime < config.firestore.saveIntervalMs
  ) {
    console.log('Sensor reading ignored because it is still inside the save interval.');
    return;
  }

  const normalized = normalizeSensorPayload(payload);
  const fieldCount = Object.keys(normalized).length;

  if (fieldCount === 0) {
    console.warn('Sensor payload ignored because no supported fields were found.', {
      topic,
      payload,
    });
    return;
  }

  const payloadTimestamp = usePayloadTimestamp
    ? readPayloadTimestamp(payload)
    : undefined;
  const document = {
    ...normalized,
    source,
    mqttTopic: topic,
    rawPayload: payload,
    timestamp: payloadTimestamp || admin.firestore.FieldValue.serverTimestamp(),
    receivedAt: new Date().toISOString(),
  };

  if (payloadTimestamp) {
    document.deviceTimestampRaw = payload.timestamp || null;
  }

  await db.collection(config.firestore.sensorCollection).add({
    ...document,
  });

  if (respectSaveInterval) {
    lastSavedTime = now;
  }

  console.log(
    `Saved ${source} sensor reading with ${fieldCount} field(s) from ${topic}.`,
  );
}

function isManualControlPayload(payload) {
  const commandSource = payload.command_source || payload.commandSource || payload.source;
  if (
    commandSource === 'ai_automation' ||
    commandSource === 'schedule_worker' ||
    commandSource === 'dss_worker' ||
    commandSource === 'dss' ||
    payload.source === 'dss_worker' ||
    payload.source === 'schedule_worker' ||
    payload.source === 'ai_automation'
  ) {
    return false;
  }

  return payload.source === 'manual' ||
    payload.source === 'manual_control' ||
    payload.manual_override === 1 ||
    payload.manual_override === true;
}

function relayCommandsFromPayload(payload) {
  const commands = [];

  for (let relay = 1; relay <= 4; relay++) {
    const rawValue = payload[`relay${relay}`];
    if (rawValue === undefined || rawValue === null) continue;

    const parsedValue = typeof rawValue === 'number'
      ? rawValue
      : Number(rawValue);
    if (!Number.isFinite(parsedValue)) continue;

    commands.push({
      relay,
      isOn: parsedValue === 1,
    });
  }

  return commands;
}

async function saveManualPumpControlLog(payload) {
  if (!isManualControlPayload(payload)) return;

  const commands = relayCommandsFromPayload(payload);
  if (commands.length === 0) return;

  for (const command of commands) {
    pendingManualPumpCommands.set(command.relay, {
      isOn: command.isOn,
      sentAt: Date.now(),
    });
    console.log(
      `Manual pump relay ${command.relay} command pending confirmation: ${command.isOn ? 'ON' : 'OFF'}.`,
    );
  }
}

async function saveManualPumpCommand(relay, isOn) {
  const session = manualPumpSessions.get(relay);

  if (isOn) {
    if (session) {
      console.log(`Manual pump relay ${relay} already has an active log session.`);
      return;
    }

    const startedAt = new Date();
    const docRef = await db.collection(config.firestore.pumpLogsCollection).add({
      relays: [relay],
      pumpLabels: [RELAY_LABELS[relay] || `Relay ${relay}`],
      durationMs: 0,
      reason: 'Kontrol manual pompa',
      action: 'running',
      metadata: {
        source: 'manual_control',
        relay,
        state: 'on',
      },
      startedAt,
      startedAtLocal: startedAt.toISOString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    manualPumpSessions.set(relay, { docRef, startedAt });
    console.log(`Manual pump relay ${relay} started and logged.`);
    return;
  }

  const finishedAt = new Date();
  if (!session) {
    console.log(`Manual pump relay ${relay} OFF confirmation ignored because no ON session exists.`);
    return;
  }

  const durationMs = finishedAt.getTime() - session.startedAt.getTime();
  const payload = {
    relays: [relay],
    pumpLabels: [RELAY_LABELS[relay] || `Relay ${relay}`],
    durationMs,
    reason: 'Kontrol manual pompa',
    action: 'completed',
    metadata: {
      source: 'manual_control',
      relay,
      state: 'off',
    },
    finishedAt: admin.firestore.FieldValue.serverTimestamp(),
    finishedAtLocal: finishedAt.toISOString(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await session.docRef.set(payload, { merge: true });
  manualPumpSessions.delete(relay);

  console.log(`Manual pump relay ${relay} stopped and logged (${durationMs}ms).`);
}

function readRelayState(payload, relay) {
  const keys = [
    `relay${relay}`,
    `Relay${relay}`,
    `RELAY${relay}`,
    `r${relay}`,
    `R${relay}`,
  ];

  for (const key of keys) {
    const rawValue = payload[key];
    if (rawValue === undefined || rawValue === null) continue;

    if (typeof rawValue === 'boolean') return rawValue;

    const parsedValue = typeof rawValue === 'number'
      ? rawValue
      : Number(rawValue);
    if (!Number.isFinite(parsedValue)) continue;

    return parsedValue === 1;
  }

  return undefined;
}

async function confirmManualPumpCommandsFromSensor(payload) {
  const now = Date.now();

  for (const [relay, command] of [...pendingManualPumpCommands.entries()]) {
    if (now - command.sentAt > MANUAL_COMMAND_CONFIRM_TIMEOUT_MS) {
      pendingManualPumpCommands.delete(relay);
      console.warn(
        `Manual pump relay ${relay} command expired without device confirmation.`,
      );
      continue;
    }

    const actualState = readRelayState(payload, relay);
    if (actualState === undefined || actualState !== command.isOn) continue;

    pendingManualPumpCommands.delete(relay);
    await saveManualPumpCommand(relay, command.isOn);
  }
}

const autoPumpSessions = new Map();

async function trackRelayStateFromSensor(payload) {
  const source = payload.source || payload.command_source || payload.commandSource || '';
  const event = payload.event || '';
  if (
    source === 'dss_worker' ||
    source === 'schedule_worker' ||
    source === 'ai_automation' ||
    source === 'dss' ||
    source === 'relay_status' ||
    source === 'realtime' ||
    event === 'relay_status'
  ) {
    return;
  }
  for (let relay = 1; relay <= 4; relay++) {
    const isOn = readRelayState(payload, relay);
    if (isOn === undefined) continue;

    const session = autoPumpSessions.get(relay);

    if (isOn) {
      if (!session && !manualPumpSessions.has(relay)) {
        const startedAt = new Date();
        const docRef = await db.collection(config.firestore.pumpLogsCollection).add({
          relays: [relay],
          pumpLabels: [RELAY_LABELS[relay] || `Relay ${relay}`],
          durationMs: 0,
          reason: 'Penjadwalan Otomatis',
          action: 'running',
          status: 'running',
          metadata: {
            source: payload.source || 'esp32_hardware',
            relay,
            state: 'on',
          },
          startedAt: admin.firestore.Timestamp.fromDate(startedAt),
          startedAtLocal: startedAt.toISOString(),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        autoPumpSessions.set(relay, { docRef, startedAt });
        console.log(`Automatic pump relay ${relay} started on ESP32 and logged to Firestore.`);
      }
    } else {
      if (session) {
        const finishedAt = new Date();
        const durationMs = finishedAt.getTime() - session.startedAt.getTime();

        await session.docRef.set({
          durationMs: durationMs,
          durationMsByRelay: { [relay]: durationMs },
          totalDurationMs: durationMs,
          action: 'completed',
          status: 'completed',
          completedAt: finishedAt.toISOString(),
          finishedAt: admin.firestore.Timestamp.fromDate(finishedAt),
          finishedAtLocal: finishedAt.toISOString(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        autoPumpSessions.delete(relay);
        console.log(`Automatic pump relay ${relay} stopped on ESP32 and completed in Firestore (${durationMs}ms).`);
      }
    }
  }
}

function startMqttWorker() {
  const url = `mqtts://${config.mqtt.host}:${config.mqtt.port}`;
  const client = mqtt.connect(url, {
    clientId: `${config.mqtt.clientId}-${Date.now().toString(36)}`,
    clean: true,
    username: config.mqtt.username,
    password: config.mqtt.password,
    reconnectPeriod: 5000,
    keepalive: 30,
  });

  client.on('connect', () => {
    console.log(`Connected to MQTT broker: ${config.mqtt.host}`);
    client.subscribe(config.mqtt.sensorTopic, { qos: 1 }, (error) => {
      if (error) {
        console.error('Failed to subscribe MQTT sensor topic:', error);
        return;
      }

      console.log(`Subscribed to sensor topic: ${config.mqtt.sensorTopic}`);
    });

    client.subscribe(config.mqtt.historyTopic, { qos: 1 }, (error) => {
      if (error) {
        console.error('Failed to subscribe MQTT history topic:', error);
        return;
      }

      console.log(`Subscribed to history topic: ${config.mqtt.historyTopic}`);
    });

    client.subscribe(config.mqtt.controlTopic, { qos: 1 }, (error) => {
      if (error) {
        console.error('Failed to subscribe MQTT control topic:', error);
        return;
      }

      console.log(`Subscribed to control topic: ${config.mqtt.controlTopic}`);
    });
  });

  client.on('message', (topic, rawPayload) => {
    Promise.resolve()
      .then(() => parsePayload(rawPayload))
      .then((payload) => {
        if (topic === config.mqtt.sensorTopic) {
          return Promise.resolve()
            .then(() => confirmManualPumpCommandsFromSensor(payload))
            .then(() => trackRelayStateFromSensor(payload))
            .then(() => {
              if (!config.firestore.saveRealtimeSensorReadings) {
                return undefined;
              }

              return saveSensorReading(topic, payload);
            });
        }

        if (topic === config.mqtt.historyTopic) {
          return saveSensorReading(topic, payload, {
            respectSaveInterval: false,
            usePayloadTimestamp: true,
            source: payload.source || 'history',
          });
        }

        if (topic === config.mqtt.controlTopic) {
          return saveManualPumpControlLog(payload);
        }

        return undefined;
      })
      .catch((error) => {
        console.error('Failed to process MQTT message:', error);
      });
  });

  client.on('reconnect', () => {
    console.log('Reconnecting to MQTT broker...');
  });

  client.on('error', (error) => {
    console.error('MQTT client error:', error.message);
  });

  client.on('close', () => {
    console.warn('MQTT connection closed.');
  });

  return client;
}

module.exports = { startMqttWorker };
