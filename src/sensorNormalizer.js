const FIELD_ALIASES = {
  nitrogen: ['nitrogen', 'Nitrogen', 'N', 'n'],
  phosphorus: ['phosphorus', 'Phosphorus', 'P', 'p'],
  potassium: ['potassium', 'Potassium', 'Kalium', 'K', 'k'],
  ph: ['ph', 'pH', 'PH'],
  moisture: ['moisture', 'Moisture', 'soil_moisture'],
  temperature: ['temperature', 'Temperature', 'Temp', 'temp'],
  ec: ['ec', 'EC', 'electrical_conductivity'],
};

function readNumber(source, keys) {
  for (const key of keys) {
    const value = source[key];

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return undefined;
}

function normalizeSensorPayload(payload) {
  const normalized = {};

  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const value = readNumber(payload, aliases);
    if (value !== undefined) {
      normalized[field] = value;
    }
  }

  return normalized;
}

module.exports = { normalizeSensorPayload };
