const { admin, db } = require('./firebase');
const { config } = require('./config');
const { sensorReadingFromFirestore } = require('./readingUtils');
const { abnormalReadings, buildThresholds } = require('./thresholdRules');

const SUMMARY_WINDOW_MS = 60 * 60 * 1000;

function formatValue(value) {
  return Number(value).toFixed(1);
}

function formatAlertLine(alert) {
  const directionText = alert.direction === 'below' ? 'di bawah batas minimal' : 'di atas batas maksimal';
  return `${alert.label}: ${formatValue(alert.value)} ${alert.unit} ${directionText} ${formatValue(alert.threshold)} ${alert.unit}`;
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
  if (!alerts || alerts.length === 0) return;

  const nStr = reading.nitrogen != null ? `${formatValue(reading.nitrogen)} mg/kg` : '-';
  const pStr = reading.phosphorus != null ? `${formatValue(reading.phosphorus)} mg/kg` : '-';
  const kStr = reading.potassium != null ? `${formatValue(reading.potassium)} mg/kg` : '-';

  const isEcLow = alerts.some((a) => a.key === 'ec' && a.status === 'Low');
  let title = 'Peringatan Sensor';
  let detailBody = '';

  if (alerts.length === 1) {
    const alert = alerts[0];
    const isLow = alert.status === 'Low';
    if (alert.key === 'ec') {
      if (isLow) {
        title = 'Nutrisi Tanaman Menurun';
        detailBody = `Nilai EC (${formatValue(alert.value)} mS/cm) di bawah batas minimal normal (${formatValue(alert.threshold)} mS/cm). Estimasi tren NPK sekarang: (N = ${nStr}, P = ${pStr}, K = ${kStr}).`;
      } else {
        title = 'Peringatan Nutrisi Tinggi';
        detailBody = `Nilai EC (${formatValue(alert.value)} mS/cm) di atas batas maksimal normal (${formatValue(alert.threshold)} mS/cm).`;
      }
    } else if (alert.key === 'ph') {
      title = isLow ? 'Peringatan pH Tanah Terlalu Asam' : 'Peringatan pH Tanah Terlalu Basa';
      const dir = isLow ? `di bawah batas minimal normal ${formatValue(alert.threshold)} pH` : `di atas batas maksimal normal ${formatValue(alert.threshold)} pH`;
      detailBody = `Nilai pH (${formatValue(alert.value)} pH) ${dir}.`;
    } else if (alert.key === 'temperature') {
      title = isLow ? 'Peringatan Suhu Tanah Rendah' : 'Peringatan Suhu Tanah Tinggi';
      const dir = isLow ? `di bawah batas minimal normal ${formatValue(alert.threshold)} °C` : `di atas batas maksimal normal ${formatValue(alert.threshold)} °C`;
      detailBody = `Suhu tanah (${formatValue(alert.value)} °C) ${dir}.`;
    } else if (alert.key === 'moisture') {
      title = isLow ? 'Peringatan Kelembapan Tanah Rendah' : 'Peringatan Kelembapan Tanah Tinggi';
      const dir = isLow ? `di bawah batas minimal normal ${formatValue(alert.threshold)} %` : `di atas batas maksimal normal ${formatValue(alert.threshold)} %`;
      detailBody = `Kelembapan tanah (${formatValue(alert.value)} %) ${dir}.`;
    } else {
      title = 'Peringatan Sensor';
      detailBody = formatAlertLine(alert);
    }
  } else {
    title = isEcLow ? 'Peringatan Nutrisi & Lingkungan' : 'Peringatan Parameter Lingkungan';
    const lines = alerts.map((alert) => {
      if (alert.key === 'ec' && alert.status === 'Low') {
        return `• EC (${formatValue(alert.value)} mS/cm) di bawah batas minimal normal (${formatValue(alert.threshold)} mS/cm). Estimasi tren NPK sekarang: (N = ${nStr}, P = ${pStr}, K = ${kStr}).`;
      }
      return `• ${formatAlertLine(alert)}`;
    });
    detailBody = lines.join('\n');
  }

  const logRef = db.collection(config.firestore.thresholdAlertLogsCollection).doc();
  const recentAlertCount = await countRecentAlertLogs(alerts);
  const summaryText = `${recentAlertCount} peringatan nutrisi terdeteksi dalam 1 jam terakhir. Buka halaman Logs untuk melihat detail.`;
  const bodyText = detailBody;

  await logRef.set({
    topic: config.automation.fcmTopic,
    title,
    body: detailBody,
    summaryBody: summaryText,
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
        body: bodyText,
        detailBody,
        message: bodyText,
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
