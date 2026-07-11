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

function readTimestampMillis(value) {
  if (!value) return undefined;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function sensorReadingFromFirestore(data) {
  return {
    nitrogen: readNumber(data, ['nitrogen', 'N', 'n']),
    phosphorus: readNumber(data, ['phosphorus', 'P', 'p']),
    potassium: readNumber(data, ['potassium', 'K', 'k']),
    ph: readNumber(data, ['ph', 'pH', 'PH']),
    moisture: readNumber(data, ['moisture', 'Moisture']),
    temperature: readNumber(data, ['temperature', 'Temp', 'temp']),
    ec: readNumber(data, ['ec', 'EC', 'electrical_conductivity']),
    timestampMillis: readTimestampMillis(data.timestamp || data.receivedAt),
  };
}

module.exports = {
  readNumber,
  readTimestampMillis,
  sensorReadingFromFirestore,
};
