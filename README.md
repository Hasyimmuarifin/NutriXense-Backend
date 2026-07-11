# NutriXense Backend

Backend worker untuk menjalankan proses NutriXense yang harus hidup 24 jam di VPS.

Tahap pertama yang sudah tersedia:

- Subscribe data sensor dari HiveMQ Cloud.
- Subscribe data history/offline-cache dari topic `nutrixense/history`.
- Normalisasi payload sensor ke field yang dipakai Flutter.
- Simpan data ke Firestore collection `sensor_data`.
- Jalankan DSS rule-based dari VPS.
- Jalankan automatic watering schedule dari VPS.
- Kirim push notification threshold dari VPS via FCM.
- Publish konfigurasi perangkat dari Firestore ke MQTT retained config.

## Setup Lokal atau VPS

```bash
cd backend
npm install
cp .env.example .env
```

Isi `.env` dengan credential HiveMQ dan Firebase Admin SDK.

Download Firebase Admin SDK dari Firebase Console:

```text
Project Settings -> Service Accounts -> Generate new private key
```

Simpan file JSON sebagai:

```text
backend/serviceAccountKey.json
```

## Menjalankan Worker

```bash
npm start
```

Jika sudah punya middleware lama `mqtt-firestore`, format `.env` berikut tetap didukung:

```env
MQTT_HOST=your-hivemq-host
MQTT_PORT=8883
MQTT_USER=your-hivemq-username
MQTT_PASS=your-hivemq-password
MQTT_TOPIC=nutrixense/sensor
MQTT_HISTORY_TOPIC=nutrixense/history
SAVE_INTERVAL_MS=60000
SAVE_REALTIME_SENSOR_TO_FIRESTORE=false
FIRESTORE_COLLECTION=sensor_data
FIREBASE_SERVICE_ACCOUNT=
```

## Firestore Collections

Backend membaca dan menulis collection berikut:

```text
sensor_data
automation_config/dss
automation_config/dss_runtime
automation_config/threshold_notifications
automation_config/threshold_notifications_runtime
watering_schedules
pump_activity_logs
threshold_alert_logs
```

Contoh dokumen `automation_config/dss`:

```json
{
  "enabled": true,
  "thresholds": {
    "min_nitrogen": 80,
    "max_nitrogen": 180,
    "min_phosphorus": 100,
    "max_phosphorus": 300,
    "min_potassium": 250,
    "max_potassium": 650,
    "min_ph": 4.5,
    "max_ph": 5.5,
    "min_moisture": 40,
    "max_moisture": 70,
    "min_temperature": 18,
    "max_temperature": 25,
    "min_ec": 1.2,
    "max_ec": 2.5
  },
  "pulseDurationMs": 5000,
  "cooldownMs": 600000
}
```

Untuk menonaktifkan buzzer dan Threshold Alert per sensor, tambahkan field
`buzzerMuted` pada dokumen yang sama:

```json
{
  "buzzerMuted": {
    "nitrogen": true,
    "phosphorus": false,
    "potassium": false,
    "ph": false,
    "moisture": false,
    "temperature": false,
    "ec": false
  }
}
```

Sensor bernilai `true` tetap tampil Low/High di aplikasi, tetapi dikeluarkan
dari notifikasi threshold dan dikirim ke perangkat sebagai `buzzer_muted`
melalui topic MQTT config.

Contoh dokumen `watering_schedules`:

```json
{
  "enabled": true,
  "hour": 7,
  "minute": 30,
  "pumpIndexes": [3],
  "durationSeconds": 10,
  "repeatsDaily": true
}
```

`pumpIndexes` mengikuti Flutter, jadi `0` berarti relay 1 dan `3` berarti relay 4. Backend juga mendukung field `relays`, misalnya `[4]`.

Contoh dokumen opsional `automation_config/threshold_notifications`:

```json
{
  "enabled": true,
  "repeatMs": 300000
}
```

Jika dokumen ini tidak ada, worker notifikasi tetap aktif mengikuti `.env`.

Status runtime notifikasi threshold bisa dicek di:

```text
automation_config/threshold_notifications_runtime
```

Nilai `state` yang umum:

- `normal`: semua nilai sensor masih dalam ambang.
- `sent`: push notification berhasil dikirim.
- `repeat_wait`: kondisi abnormal masih sama, tapi jeda kirim ulang belum lewat.
- `sensor_stale`: data sensor terbaru terlalu lama.
- `error`: terjadi error pengiriman atau pembacaan data.

Untuk VPS, jalankan dengan PM2:

```bash
npm install -g pm2
pm2 start src/index.js --name nutrixense-backend
pm2 save
pm2 startup
```

## Payload MQTT yang Didukung

Worker menerima variasi key dari perangkat, lalu menyimpannya sebagai field standar.
Topic realtime `nutrixense/sensor` tetap dibatasi oleh `SAVE_INTERVAL_MS`, sedangkan
topic history `nutrixense/history` disimpan satu per satu agar batch LittleFS dari
ESP32 tidak terlewat. Jika payload history membawa `timestamp` dari ESP32, backend
akan menyimpannya sebagai timestamp Firestore untuk menu History.
Untuk sketch ESP32 yang sudah rutin mengirim history, gunakan
`SAVE_REALTIME_SENSOR_TO_FIRESTORE=false` agar koleksi `sensor_data` tidak berisi
duplikasi dari topic realtime.

Contoh:

```json
{
  "N": 42,
  "P": 25,
  "K": 51,
  "pH": 6.4,
  "Moisture": 58,
  "Temp": 29.5,
  "EC": 1.8
}
```

Backend juga publish retained config ke topic `nutrixense/config`
atau nilai `.env` `MQTT_CONFIG_TOPIC`:

```json
{
  "min_nitrogen": 80,
  "max_nitrogen": 180,
  "min_phosphorus": 100,
  "max_phosphorus": 300,
  "min_potassium": 250,
  "max_potassium": 650,
  "min_ph": 4.5,
  "max_ph": 5.5,
  "min_moisture": 40,
  "max_moisture": 70,
  "min_temperature": 18,
  "max_temperature": 25,
  "min_ec": 1.2,
  "max_ec": 2.5,
  "buzzer_muted": {
    "nitrogen": true,
    "phosphorus": false,
    "potassium": false,
    "ph": false,
    "moisture": false,
    "temperature": false,
    "ec": false
  }
}
```

Akan disimpan ke Firestore sebagai:

```json
{
  "nitrogen": 42,
  "phosphorus": 25,
  "potassium": 51,
  "ph": 6.4,
  "moisture": 58,
  "temperature": 29.5,
  "ec": 1.8,
  "timestamp": "server timestamp"
}
```

## Catatan Keamanan

Jangan commit file berikut:

- `.env`
- `serviceAccountKey.json`
- file credential Firebase lainnya

File tersebut sudah dimasukkan ke `.gitignore`.
