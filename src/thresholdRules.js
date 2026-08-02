const DEFAULT_THRESHOLDS = {
  min_nitrogen: 100,
  max_nitrogen: 200,
  min_phosphorus: 20,
  max_phosphorus: 50,
  min_potassium: 100,
  max_potassium: 200,
  min_ph: 4.5,
  max_ph: 5.5,
  min_moisture: 40,
  max_moisture: 70,
  min_temperature: 18,
  max_temperature: 25,
  min_ec: 0.8,
  max_ec: 1.8,
};

const PREVIOUS_TEA_POT_THRESHOLDS = {
  min_nitrogen: 80,
  max_nitrogen: 180,
  min_phosphorus: 100,
  max_phosphorus: 300,
  min_potassium: 250,
  max_potassium: 650,
  min_ph: 4.5,
  max_ph: 5.5,
  min_moisture: 40,
  max_moisture: 70,
  min_temperature: 18,
  max_temperature: 25,
  min_ec: 1.2,
  max_ec: 2.5,
};

const LEGACY_DEFAULT_THRESHOLDS = {
  min_nitrogen: 40,
  max_nitrogen: 80,
  min_phosphorus: 20,
  max_phosphorus: 60,
  min_potassium: 40,
  max_potassium: 100,
  min_ph: 5.8,
  max_ph: 7.2,
  min_moisture: 40,
  max_moisture: 80,
  min_temperature: 18,
  max_temperature: 35,
  min_ec: 1.0,
  max_ec: 3.0,
};

const SENSOR_DEFINITIONS = [
  {
    key: 'nitrogen',
    label: 'Estimasi Nitrogen',
    unit: 'mg/kg',
    minKey: 'min_nitrogen',
    maxKey: 'max_nitrogen',
  },
  {
    key: 'phosphorus',
    label: 'Estimasi Phosphorus',
    unit: 'mg/kg',
    minKey: 'min_phosphorus',
    maxKey: 'max_phosphorus',
  },
  {
    key: 'potassium',
    label: 'Estimasi Kalium',
    unit: 'mg/kg',
    minKey: 'min_potassium',
    maxKey: 'max_potassium',
  },
  {
    key: 'ph',
    label: 'pH',
    unit: 'pH',
    minKey: 'min_ph',
    maxKey: 'max_ph',
  },
  {
    key: 'moisture',
    label: 'Moisture',
    unit: '%',
    minKey: 'min_moisture',
    maxKey: 'max_moisture',
  },
  {
    key: 'temperature',
    label: 'Temperature',
    unit: 'C',
    minKey: 'min_temperature',
    maxKey: 'max_temperature',
  },
  {
    key: 'ec',
    label: 'Electrical Conductivity',
    unit: 'mS/cm',
    minKey: 'min_ec',
    maxKey: 'max_ec',
  },
];

function buildThresholds(configData = {}) {
  if (
    isDefaultThresholds(configData.thresholds, LEGACY_DEFAULT_THRESHOLDS) ||
    isDefaultThresholds(configData.thresholds, PREVIOUS_TEA_POT_THRESHOLDS)
  ) {
    return { ...DEFAULT_THRESHOLDS };
  }

  return {
    ...DEFAULT_THRESHOLDS,
    ...(configData.thresholds || {}),
  };
}

function isDefaultThresholds(thresholds = {}, defaults = {}) {
  const keys = Object.keys(defaults);
  if (Object.keys(thresholds).length !== keys.length) return false;

  return keys.every((key) => {
    const value = thresholds[key];
    return typeof value === 'number' &&
      Math.abs(value - defaults[key]) < 0.0001;
  });
}

function abnormalReadings(reading, thresholds) {
  return SENSOR_DEFINITIONS.flatMap((definition) => {
    const value = reading[definition.key];
    if (typeof value !== 'number') return [];

    const minimum = thresholds[definition.minKey];
    const maximum = thresholds[definition.maxKey];

    if (typeof minimum === 'number' && value < minimum) {
      return [
        {
          ...definition,
          value,
          status: 'Low',
          direction: 'below',
          threshold: minimum,
        },
      ];
    }

    if (typeof maximum === 'number' && value > maximum) {
      return [
        {
          ...definition,
          value,
          status: 'High',
          direction: 'above',
          threshold: maximum,
        },
      ];
    }

    return [];
  });
}

module.exports = {
  DEFAULT_THRESHOLDS,
  SENSOR_DEFINITIONS,
  abnormalReadings,
  buildThresholds,
};
