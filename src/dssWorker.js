const { admin, db } = require('./firebase');
const { config } = require('./config');
const { runPumpPulseByRelay } = require('./pumpController');
const { sensorReadingFromFirestore } = require('./readingUtils');
const { DEFAULT_THRESHOLDS, buildThresholds } = require('./thresholdRules');

let lastDssExecutionTime = 0;
let lastProcessedReadingId = null;

function isLow(value, minimum) {
  return typeof value === 'number' && typeof minimum === 'number' && value < minimum;
}

function isHigh(value, maximum) {
  return typeof value === 'number' && typeof maximum === 'number' && value > maximum;
}

function durationConfigFromData(data = {}) {
  const fuzzyLogic = data.fuzzyLogic || {};
  return {
    minMs:
      Number(data.minPulseMs) ||
      Number(fuzzyLogic.minPulseSeconds) * 1000 ||
      1 * 1000,
    mediumMs:
      Number(data.mediumPulseMs) ||
      Number(fuzzyLogic.mediumPulseSeconds) * 1000 ||
      2 * 1000,
    maxMs:
      Number(data.maxPulseMs) ||
      Number(fuzzyLogic.maxPulseSeconds) * 1000 ||
      3 * 1000,
  };
}

function fuzzyLevelForRatio(gapRatio) {
  if (gapRatio <= 0.30) {
    return {
      label: 'Minimum',
      condition: 'Tipis',
      durationKey: 'minMs',
    };
  }

  if (gapRatio <= 0.60) {
    return {
      label: 'Sedang',
      condition: 'Sedang',
      durationKey: 'mediumMs',
    };
  }

  return {
    label: 'Maksimum',
    condition: 'Parah',
    durationKey: 'maxMs',
  };
}

function lowDecision(reading, sensorKey, minKey, relay, thresholds, durations) {
  const value = reading[sensorKey];
  const minimum = thresholds[minKey];
  if (!isLow(value, minimum) || minimum <= 0) return [];

  const gapRatio = Math.min(Math.max((minimum - value) / minimum, 0), 1);
  const fuzzy = fuzzyLevelForRatio(gapRatio);
  return [{
    sensorKey,
    direction: 'low',
    relay,
    threshold: minimum,
    value,
    gapRatio,
    fuzzyCondition: fuzzy.condition,
    fuzzyOutput: fuzzy.label,
    durationMs: durations[fuzzy.durationKey],
  }];
}

function highDecision(reading, sensorKey, maxKey, relay, thresholds, durations) {
  const value = reading[sensorKey];
  const maximum = thresholds[maxKey];
  if (!isHigh(value, maximum) || maximum <= 0) return [];

  const gapRatio = Math.min(Math.max((value - maximum) / maximum, 0), 1);
  const fuzzy = fuzzyLevelForRatio(gapRatio);
  return [{
    sensorKey,
    direction: 'high',
    relay,
    threshold: maximum,
    value,
    gapRatio,
    fuzzyCondition: fuzzy.condition,
    fuzzyOutput: fuzzy.label,
    durationMs: durations[fuzzy.durationKey],
  }];
}

function readRecipeRatio(data = {}) {
  const recipe = data.recipeDosing || data.nutrientRecipe || {};
  const ratios = recipe.relayRatios || recipe.ratios || {};
  return {
    1: Number(ratios[1] ?? ratios.relay1 ?? ratios.nitrogen ?? 1),
    2: Number(ratios[2] ?? ratios.relay2 ?? ratios.phosphorus ?? 1),
    3: Number(ratios[3] ?? ratios.relay3 ?? ratios.potassium ?? 1),
  };
}

function recipeDurationsFromEc(reading, thresholds, durations, recipeRatios) {
  const ec = reading.ec;
  const minimum = thresholds.min_ec;
  if (!isLow(ec, minimum) || minimum <= 0) return [];

  const gapRatio = Math.min(Math.max((minimum - ec) / minimum, 0), 1);
  const fuzzy = fuzzyLevelForRatio(gapRatio);
  const baseDurationMs = durations[fuzzy.durationKey];

  return [1, 2, 3].flatMap((relay) => {
    const ratio = Number(recipeRatios[relay]);
    if (!Number.isFinite(ratio) || ratio <= 0) return [];

    return [{
      sensorKey: 'ec',
      direction: 'low',
      relay,
      threshold: minimum,
      value: ec,
      gapRatio,
      fuzzyCondition: fuzzy.condition,
      fuzzyOutput: fuzzy.label,
      durationMs: Math.max(1000, Math.round(baseDurationMs * ratio)),
      dosingMode: 'ec_recipe',
      recipeRatio: ratio,
      note:
        'NPK relay is activated from EC-based stock-solution recipe dosing; CWT NPK values are treated as estimated trends, not independent elemental measurements.',
    }];
  });
}

function fuzzyDecisionsForReading(reading, thresholds, durations) {
  return [
    ...lowDecision(reading, 'moisture', 'min_moisture', 4, thresholds, durations),
    ...highDecision(reading, 'temperature', 'max_temperature', 4, thresholds, durations),
  ];
}

function durationMsByRelay(decisions) {
  return decisions.reduce((durations, decision) => {
    durations[decision.relay] = Math.max(
      durations[decision.relay] || 0,
      decision.durationMs,
    );
    return durations;
  }, {});
}

async function loadDssConfig() {
  const primarySnapshot = await db
    .collection(config.firestore.automationConfigCollection)
    .doc(config.firestore.dssConfigDocument)
    .get();
  const fallbackSnapshot = await db
    .collection(config.firestore.wateringSchedulesCollection)
    .doc('_dss_config')
    .get();

  const primaryData = primarySnapshot.exists ? primarySnapshot.data() : {};
  const fallbackData = fallbackSnapshot.exists ? fallbackSnapshot.data() : {};
  const data = {
    ...primaryData,
    ...fallbackData,
    thresholds: {
      ...(primaryData.thresholds || {}),
      ...(fallbackData.thresholds || {}),
    },
  };
  const durations = durationConfigFromData(data);
  return {
    enabled: data.enabled === true,
    thresholds: buildThresholds(data),
    durations,
    recipeRatios: readRecipeRatio(data),
  };
}

async function writeDssRuntimeStatus(status) {
  try {
    await db
      .collection(config.firestore.automationConfigCollection)
      .doc('dss_runtime')
      .set(
        {
          ...status,
          cooldownMs: admin.firestore.FieldValue.delete(),
          checkedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  } catch (error) {
    console.error('Failed to write DSS runtime status:', error.message);
  }
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

function startDssWorker(mqttClient) {
  let isChecking = false;

  async function check() {
    if (isChecking) return;
    isChecking = true;

    try {
      const dssConfig = await loadDssConfig();
      if (!dssConfig.enabled) {
        await writeDssRuntimeStatus({
          state: 'disabled',
          message: 'DSS is disabled in Firestore config.',
        });
        return;
      }

      const reading = await loadLatestReading();
      if (!reading) {
        await writeDssRuntimeStatus({
          state: 'no_reading',
          message: 'No sensor reading found in Firestore.',
        });
        return;
      }

      if (
        reading.timestampMillis &&
        Date.now() - reading.timestampMillis > config.automation.maxSensorAgeMs
      ) {
        console.warn('DSS skipped because latest sensor reading is stale.');
        await writeDssRuntimeStatus({
          state: 'sensor_stale',
          message: 'Latest sensor reading is older than DSS_MAX_SENSOR_AGE_MS.',
          sensorReadingId: reading.id,
          sensorAgeMs: Date.now() - reading.timestampMillis,
          maxSensorAgeMs: config.automation.maxSensorAgeMs,
        });
        return;
      }

      const decisions = [
        ...fuzzyDecisionsForReading(
          reading,
          dssConfig.thresholds,
          dssConfig.durations,
        ),
        ...recipeDurationsFromEc(
          reading,
          dssConfig.thresholds,
          dssConfig.durations,
          dssConfig.recipeRatios,
        ),
      ];

      if (decisions.length === 0) {
        await writeDssRuntimeStatus({
          state: 'normal',
          message: 'All values are inside thresholds, all relays remain off.',
          sensorReadingId: reading.id,
          reading,
          thresholds: dssConfig.thresholds,
        });
        return;
      }

      const relayDurations = durationMsByRelay(decisions);
      const matchedRelays = Object.keys(relayDurations).map(Number);
      const allowedDurations = Object.fromEntries(
        matchedRelays.map((relay) => [relay, relayDurations[relay]]),
      );

      const nowMs = Date.now();
      if (reading.id && reading.id === lastProcessedReadingId) {
        return;
      }
      const cooldownMs = config.automation.dssCooldownMs || 10 * 60 * 1000;
      if (nowMs - lastDssExecutionTime < cooldownMs) {
        console.log(`DSS pulse skipped due to ${Math.round(cooldownMs / 60000)}-minute cooldown window.`);
        return;
      }
      lastDssExecutionTime = nowMs;
      lastProcessedReadingId = reading.id;

      await runPumpPulseByRelay(
        mqttClient,
        allowedDurations,
        'Pompa Otomatis',
        {
          source: 'dss_worker',
          sensorReadingId: reading.id,
          thresholds: dssConfig.thresholds,
          recipeRatios: dssConfig.recipeRatios,
          fuzzyDurations: dssConfig.durations,
          decisions,
        },
      );

      await writeDssRuntimeStatus({
        state: 'activated',
        message: 'DSS activated pump relay(s).',
        sensorReadingId: reading.id,
        matchedRelays,
        activatedRelays: matchedRelays,
        durationMsByRelay: allowedDurations,
      });
    } catch (error) {
      console.error('DSS worker check failed:', error);
      await writeDssRuntimeStatus({
        state: 'error',
        message: error.message,
      });
    } finally {
      isChecking = false;
    }
  }

  check();
  const timer = setInterval(check, config.automation.dssCheckIntervalMs);
  return { stop: () => clearInterval(timer) };
}

module.exports = { startDssWorker, DEFAULT_THRESHOLDS };
