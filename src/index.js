const { startMqttWorker } = require('./mqttWorker');
const { startDssWorker } = require('./dssWorker');
const { startScheduleWorker } = require('./scheduleWorker');
const { startDeviceConfigWorker } = require('./deviceConfigWorker');
const {
  startThresholdNotificationWorker,
} = require('./thresholdNotificationWorker');

console.log('Starting NutriXense backend workers...');

const mqttClient = startMqttWorker();
const dssWorker = startDssWorker(mqttClient);
const scheduleWorker = startScheduleWorker(mqttClient);
const deviceConfigWorker = startDeviceConfigWorker(mqttClient);
const thresholdNotificationWorker = startThresholdNotificationWorker();

function stopBackend() {
  dssWorker.stop();
  scheduleWorker.stop();
  deviceConfigWorker.stop();
  thresholdNotificationWorker.stop();
  console.log('NutriXense backend stopped.');
  process.exit(0);
}

process.on('SIGINT', stopBackend);
process.on('SIGTERM', stopBackend);
