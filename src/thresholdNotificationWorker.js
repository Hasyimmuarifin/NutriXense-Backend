const { admin, db } = require('./firebase');
const { config } = require('./config');
const { sensorReadingFromFirestore } = require('./readingUtils');
const { abnormalReadings, buildThresholds } = require('./thresholdRules');

const SUMMARY_WINDOW_MS = 60 * 60 * 1000;

function formatValue(value) {
  return Number(value).toFixed(1);
}

function formatAlertLine(alert) {
  return `${alert.label}: ${formatValue(alert.value)} ${alert.unit} is ${alert.direction} ${formatValue(alert.threshold)} ${alert.unit}`;
}

function alertCountForLogData(data = {}) {
  return Array.isArray(data.alerts) && data.alerts.length > 0
    ? data.alerts.length
    : 1;
}

async function countRecentAlertLogs(currentAlerts) {
  const since = admin.firestore.Timestamp.fromMillis(Date.now() - SUMMARY_WINDOW_MS);
  const snapshot = await db
    .collection(config.firestore.thresholdAlertLogsCollection)
    .where('createdAt', '>=', since)
    .limit(300)
    .get();

  let count = currentAlerts.length;
  snapshot.docs.forEach((doc) => {
    count += alertCountForLogData(doc.data());
  });
  return count;
}

function readMutedSensors(...configs) {
  return configs.reduce((mutedSensors, item) => {
    const rawMuted = item?.buzzerMuted || item?.buzzer_muted || {};
    for (const [key, value] of Object.entries(rawMuted)) {
      mutedSensors[key] = value === true || value === 1;
    }
    return mutedSensors;
  }, {});
}

function runtimeConfigSnapshot(extra = {}) {
  return {
    intervalMs: config.automation.thresholdNotificationIntervalMs,
    repeatMs: config.automation.thresholdNotificationRepeatMs,
    maxSensorAgeMs: config.automation.thresholdNotificationMaxSensorAgeMs,
    fcmTopic: config.automation.fcmTopic,
    fcmChannelId: config.automation.fcmChannelId,
    ...extra,
  };
}

async function writeRuntimeStatus(status) {
  try {
    await db
      .collection(config.firestore.automationConfigCollection)
      .doc('threshold_notifications_runtime')
      .set(
        {
          ...status,
          checkedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  } catch (error) {
    console.error('Failed to write threshold notification runtime:', error.message);
  }
}

async function loadNotificationConfig() {
  const dssSnapshot = await db
    .collection(config.firestore.automationConfigCollection)
    .doc(config.firestore.dssConfigDocument)
    .get();
  const fallbackSnapshot = await db
    .collection(config.firestore.wateringSchedulesCollection)
    .doc('_dss_config')
    .get();
  const notificationSnapshot = await db
    .collection(config.firestore.automationConfigCollection)
    .doc('threshold_notifications')
    .get();

  const dssData = dssSnapshot.exists ? dssSnapshot.data() : {};
  const fallbackData = fallbackSnapshot.exists ? fallbackSnapshot.data() : {};
  const notificationData = notificationSnapshot.exists
    ? notificationSnapshot.data()
    : {};
  const data = {
    ...dssData,
    ...fallbackData,
    ...notificationData,
    thresholds: {
      ...(dssData.thresholds || {}),
      ...(fallbackData.thresholds || {}),
      ...(notificationData.thresholds || {}),
    },
  };

  return {
    enabled:
      notificationData.enabled !== undefined
        ? notificationData.enabled === true
        : config.automation.thresholdNotificationEnabled,
    thresholds: buildThresholds(data),
    mutedSensors: readMutedSensors(dssData, fallbackData, notificationData),
    repeatMs: config.automation.thresholdNotificationRepeatMs,
  };
}

async function loadLatestReading() {
  const snapshot = await db
    .collection(config.firestore.sensorCollection)
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();

  if (snapshot.empty) return undefined;
  return {
    id: snapshot.docs[0].id,
    ...sensorReadingFromFirestore(snapshot.docs[0].data()),
  };
}

async function sendThresholdNotification(alerts, reading) {
  const ecLowAlert = alerts.find((a) => a.key === 'ec' && a.status === 'Low');
  let title = 'Peringatan Nutrisi Tanaman';
  let detailBody = alerts.map(formatAlertLine).join('\n');

  if (ecLowAlert) {
    title = 'Nutrisi Tanaman Menurun';
    const nStr = reading.nitrogen != null ? `${formatValue(reading.nitrogen)} mg/kg` : '-';
    const pStr = reading.phosphorus != null ? `${formatValue(reading.phosphorus)} mg/kg` : '-';
    const kStr = reading.potassium != null ? `${formatValue(reading.potassium)} mg/kg` : '-';
    detailBody = `Nilai EC (${formatValue(ecLowAlert.value)} mS/cm) di bawah batas normal. (Estimasi Tren NPK: N ${nStr}, P ${pStr}, K ${kStr}).`;
  }

  const logRef = db.collection(config.firestore.thresholdAlertLogsCollection).doc();
  const recentAlertCount = await countRecentAlertLogs(alerts);
  const body = `${recentAlertCount} peringatan nutrisi terdeteksi dalam 1 jam terakhir. Buka halaman Logs untuk melihat detail.`;

  await logRef.set({
    topic: config.automation.fcmTopic,
    title,
    body: detailBody,
    summaryBody: body,
    recentAlertCount,
    alerts,
    sensorReadingId: reading.id,
    deliveryStatus: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  try {
    const response = await admin.messaging().send({
      topic: config.automation.fcmTopic,
      data: {
        title,
        body,
        detailBody,
        message: body,
        type: 'threshold_alert',
        sensorReadingId: reading.id,
        alertCount: String(alerts.length),
        recentAlertCount: String(recentAlertCount),
        logId: logRef.id,
        notificationKey: logRef.id,
      },
      android: {
        priority: 'high',
        ttl: 60 * 60 * 1000,
      },
    });

    await logRef.set(
      {
        fcmMessageId: response,
        deliveryStatus: 'sent',
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      logId: logRef.id,
      fcmMessageId: response,
      deliveryStatus: 'sent',
    };
  } catch (error) {
    console.error('Failed to send threshold FCM notification:', error.message);

    await logRef.set(
      {
        deliveryStatus: 'failed',
        fcmError: error.message,
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      logId: logRef.id,
      fcmMessageId: null,
      deliveryStatus: 'failed',
      fcmError: error.message,
    };
  }
}

function startThresholdNotificationWorker() {
  let isChecking = false;

  async function check() {
    if (isChecking) return;
    isChecking = true;

    try {
      const notificationConfig = await loadNotificationConfig();
      if (!notificationConfig.enabled) {
        await writeRuntimeStatus({
          state: 'disabled',
          message: 'Threshold notification worker is disabled.',
          ...runtimeConfigSnapshot(),
        });
        return;
      }

      const reading = await loadLatestReading();
      if (!reading) {
        await writeRuntimeStatus({
          state: 'no_reading',
          message: 'No sensor reading found in Firestore.',
          ...runtimeConfigSnapshot(),
        });
        return;
      }

      if (
        reading.timestampMillis &&
        Date.now() - reading.timestampMillis >
          config.automation.thresholdNotificationMaxSensorAgeMs
      ) {
        await writeRuntimeStatus({
          state: 'sensor_stale',
          message:
            'Latest sensor reading is older than THRESHOLD_NOTIFICATION_MAX_SENSOR_AGE_MS.',
          sensorReadingId: reading.id,
          sensorAgeMs: Date.now() - reading.timestampMillis,
          ...runtimeConfigSnapshot(),
        });
        return;
      }

      const alerts = abnormalReadings(reading, notificationConfig.thresholds)
        .filter((alert) => {
          if (alert.key === 'nitrogen' || alert.key === 'phosphorus' || alert.key === 'potassium') {
            return false;
          }
          return notificationConfig.mutedSensors[alert.key] !== true;
        });
      if (alerts.length === 0) {
        await writeRuntimeStatus({
          state: 'normal',
          message:
            'All unmuted readings are inside configured thresholds.',
          sensorReadingId: reading.id,
          mutedSensors: notificationConfig.mutedSensors,
          ...runtimeConfigSnapshot(),
        });
        return;
      }

      const delivery = await sendThresholdNotification(alerts, reading);

      await writeRuntimeStatus({
        state: delivery.deliveryStatus === 'sent' ? 'sent' : 'fcm_failed',
        message: delivery.deliveryStatus === 'sent'
          ? 'Threshold push notification sent.'
          : 'Threshold alert logged, but FCM push failed.',
        sensorReadingId: reading.id,
        alerts,
        mutedSensors: notificationConfig.mutedSensors,
        logId: delivery.logId,
        fcmMessageId: delivery.fcmMessageId,
        fcmError: delivery.fcmError || null,
        deliveryStatus: delivery.deliveryStatus,
        ...runtimeConfigSnapshot(),
      });
    } catch (error) {
      console.error('Threshold notification worker check failed:', error);
      await writeRuntimeStatus({
        state: 'error',
        message: error.message,
        ...runtimeConfigSnapshot(),
      });
    } finally {
      isChecking = false;
    }
  }

  check();
  const timer = setInterval(
    check,
    config.automation.thresholdNotificationIntervalMs,
  );
  return { stop: () => clearInterval(timer) };
}

module.exports = { startThresholdNotificationWorker };
