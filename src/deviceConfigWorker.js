const { db } = require('./firebase');
const { config } = require('./config');
const { buildThresholds } = require('./thresholdRules');

function readMutedSensors(configData = {}) {
  const rawMuted = configData.buzzerMuted || configData.buzzer_muted || {};
  return normalizeMutedSensors(rawMuted);
}

function normalizeMutedSensors(rawMuted = {}) {
  const sensorKeys = [
    'nitrogen',
    'phosphorus',
    'potassium',
    'ph',
    'moisture',
    'temperature',
    'ec',
  ];

  return sensorKeys.reduce((muted, key) => {
    muted[key] = rawMuted[key] === true || rawMuted[key] === 1;
    return muted;
  }, {});
}

function publishDeviceConfig(mqttClient, configData = {}) {
  if (!mqttClient.connected) {
    console.warn('Device config publish skipped because MQTT is disconnected.');
    return;
  }

  const payload = {
    ...buildThresholds(configData),
    buzzer_muted: readMutedSensors(configData),
  };

  mqttClient.publish(
    config.mqtt.configTopic,
    JSON.stringify(payload),
    { qos: 1, retain: true },
    (error) => {
      if (error) {
        console.error('Failed to publish device config:', error.message);
        return;
      }

      console.log(`Published retained device config to ${config.mqtt.configTopic}.`);
    },
  );
}

function startDeviceConfigWorker(mqttClient) {
  const unsubscribe = db
    .collection(config.firestore.automationConfigCollection)
    .doc(config.firestore.dssConfigDocument)
    .onSnapshot(
      (snapshot) => {
        const data = snapshot.exists ? snapshot.data() : {};
        publishDeviceConfig(mqttClient, data);
      },
      (error) => {
        console.error('Device config listener failed:', error.message);
      },
    );

  mqttClient.on('connect', async () => {
    try {
      const snapshot = await db
        .collection(config.firestore.automationConfigCollection)
        .doc(config.firestore.dssConfigDocument)
        .get();
      publishDeviceConfig(mqttClient, snapshot.exists ? snapshot.data() : {});
    } catch (error) {
      console.error('Failed to load device config after MQTT connect:', error.message);
    }
  });

  return { stop: () => unsubscribe() };
}

module.exports = { startDeviceConfigWorker };
