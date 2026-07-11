const { admin, db } = require('./firebase');
const { config } = require('./config');
const { runPumpPulseByRelay, validRelays } = require('./pumpController');

function localDateParts(date = new Date()) {
  const shifted = new Date(
    date.getTime() + config.automation.timezoneOffsetMinutes * 60 * 1000,
  );
  const iso = shifted.toISOString();
  return {
    dateKey: iso.slice(0, 10),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function readRelays(schedule) {
  if (Array.isArray(schedule.relays)) {
    return validRelays(schedule.relays);
  }

  if (Array.isArray(schedule.pumpIndexes)) {
    return validRelays(schedule.pumpIndexes.map((index) => Number(index) + 1));
  }

  return [];
}

function readDurationMsByRelay(schedule, relays) {
  const defaultDurationSeconds = Number(schedule.durationSeconds);
  const durationSecondsByPump =
    schedule.durationSecondsByPump && typeof schedule.durationSecondsByPump === 'object'
      ? schedule.durationSecondsByPump
      : {};
  const durationMsByRelay =
    schedule.durationMsByRelay && typeof schedule.durationMsByRelay === 'object'
      ? schedule.durationMsByRelay
      : {};

  return Object.fromEntries(
    relays
      .map((relay) => {
        const pumpIndex = relay - 1;
        const secondsByPump = Number(durationSecondsByPump[pumpIndex]);
        const directMs = Number(durationMsByRelay[relay]);
        const durationMs = Number.isFinite(secondsByPump) && secondsByPump > 0
          ? secondsByPump * 1000
          : Number.isFinite(directMs) && directMs > 0
            ? directMs
            : defaultDurationSeconds * 1000;

        return [relay, durationMs];
      })
      .filter(([, durationMs]) => Number.isFinite(durationMs) && durationMs > 0),
  );
}

async function markScheduleRun(scheduleRef, dateKey, repeatsDaily) {
  await scheduleRef.set(
    {
      lastRunDateKey: dateKey,
      lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
      enabled: repeatsDaily ? true : false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

function startScheduleWorker(mqttClient) {
  let isChecking = false;

  async function check() {
    if (isChecking) return;
    isChecking = true;

    try {
      const now = localDateParts();
      const snapshot = await db
        .collection(config.firestore.wateringSchedulesCollection)
        .where('enabled', '==', true)
        .where('hour', '==', now.hour)
        .where('minute', '==', now.minute)
        .get();

      for (const doc of snapshot.docs) {
        const schedule = doc.data();
        if (schedule.lastRunDateKey === now.dateKey) continue;

        const relays = readRelays(schedule);
        const durationMsByRelay = readDurationMsByRelay(schedule, relays);
        if (relays.length === 0 || Object.keys(durationMsByRelay).length === 0) {
          console.warn(`Watering schedule ${doc.id} ignored because it is invalid.`);
          continue;
        }

        await markScheduleRun(doc.ref, now.dateKey, schedule.repeatsDaily === true);
        await runPumpPulseByRelay(
          mqttClient,
          durationMsByRelay,
          'Penjadwalan Otomatis',
          {
            source: 'schedule_worker',
            scheduleId: doc.id,
            dateKey: now.dateKey,
          },
        );
      }
    } catch (error) {
      console.error('Schedule worker check failed:', error);
    } finally {
      isChecking = false;
    }
  }

  check();
  const timer = setInterval(check, config.automation.scheduleCheckIntervalMs);
  return { stop: () => clearInterval(timer) };
}

module.exports = { startScheduleWorker };
