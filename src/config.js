const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function readRequiredEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function readFirstEnv(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim() !== '') {
      return value.trim();
    }
  }

  throw new Error(`Missing required environment variable: ${names.join(' or ')}`);
}

function readNumberEnv(name, fallback) {
  const rawValue = process.env[name];
  if (!rawValue) return fallback;

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number.`);
  }

  return parsed;
}

const config = {
  mqtt: {
    host: readRequiredEnv('MQTT_HOST'),
    port: readNumberEnv('MQTT_PORT', 8883),
    username: readFirstEnv(['MQTT_USER', 'MQTT_USERNAME']),
    password: readFirstEnv(['MQTT_PASS', 'MQTT_PASSWORD']),
    sensorTopic:
      process.env.MQTT_TOPIC ||
      process.env.MQTT_SENSOR_TOPIC ||
      'nutrixense/sensor',
    historyTopic: process.env.MQTT_HISTORY_TOPIC || 'nutrixense/history',
    controlTopic: process.env.MQTT_CONTROL_TOPIC || 'nutrixense/control',
    configTopic: process.env.MQTT_CONFIG_TOPIC || 'nutrixense/config',
    clientId:
      process.env.MQTT_CLIENT_ID ||
      `nutrixense-backend-${Date.now().toString(36)}`,
  },
  firebase: {
    serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
    serviceAccountJson:
      process.env.FIREBASE_SERVICE_ACCOUNT ||
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
  },
  firestore: {
    sensorCollection:
      process.env.FIRESTORE_COLLECTION ||
      process.env.FIRESTORE_SENSOR_COLLECTION ||
      'sensor_data',
    saveIntervalMs: readNumberEnv('SAVE_INTERVAL_MS', 60 * 1000),
    saveRealtimeSensorReadings:
      (process.env.SAVE_REALTIME_SENSOR_TO_FIRESTORE || 'true') !== 'false',
    automationConfigCollection:
      process.env.FIRESTORE_AUTOMATION_CONFIG_COLLECTION ||
      'automation_config',
    dssConfigDocument: process.env.FIRESTORE_DSS_CONFIG_DOCUMENT || 'dss',
    wateringSchedulesCollection:
      process.env.FIRESTORE_WATERING_SCHEDULES_COLLECTION ||
      'watering_schedules',
    pumpLogsCollection:
      process.env.FIRESTORE_PUMP_LOGS_COLLECTION || 'pump_activity_logs',
    thresholdAlertLogsCollection:
      process.env.FIRESTORE_THRESHOLD_ALERT_LOGS_COLLECTION ||
      'threshold_alert_logs',
  },
  automation: {
    dssCheckIntervalMs: readNumberEnv('DSS_CHECK_INTERVAL_MS', 2 * 60 * 1000),
    dssPulseDurationMs: readNumberEnv('DSS_PULSE_DURATION_MS', 5 * 1000),
    maxSensorAgeMs: readNumberEnv('DSS_MAX_SENSOR_AGE_MS', 10 * 60 * 1000),
    scheduleCheckIntervalMs: readNumberEnv(
      'SCHEDULE_CHECK_INTERVAL_MS',
      15 * 1000,
    ),
    timezoneOffsetMinutes: readNumberEnv('TIMEZONE_OFFSET_MINUTES', 7 * 60),
    thresholdNotificationEnabled:
      (process.env.THRESHOLD_NOTIFICATION_ENABLED || 'true') !== 'false',
    thresholdNotificationIntervalMs: 5 * 60 * 1000,
    thresholdNotificationRepeatMs: 5 * 60 * 1000,
    thresholdNotificationMaxSensorAgeMs: readNumberEnv(
      'THRESHOLD_NOTIFICATION_MAX_SENSOR_AGE_MS',
      10 * 60 * 1000,
    ),
    fcmTopic: process.env.FCM_ALERT_TOPIC || 'nutrixense_alerts',
    fcmChannelId: process.env.FCM_CHANNEL_ID || 'nutrixense_fcm_alerts',
  },
};

module.exports = { config };
