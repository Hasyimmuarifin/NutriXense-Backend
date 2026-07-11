const fs = require('node:fs');
const path = require('node:path');
const admin = require('firebase-admin');
const { config } = require('./config');

function loadServiceAccount() {
  if (config.firebase.serviceAccountJson) {
    return JSON.parse(config.firebase.serviceAccountJson);
  }

  if (!config.firebase.serviceAccountPath) {
    throw new Error(
      'Set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON.',
    );
  }

  const serviceAccountPath = path.resolve(
    __dirname,
    '..',
    config.firebase.serviceAccountPath,
  );
  const rawJson = fs.readFileSync(serviceAccountPath, 'utf8');
  return JSON.parse(rawJson);
}

function initializeFirebase() {
  if (admin.apps.length > 0) {
    return admin.app();
  }

  const serviceAccount = loadServiceAccount();
  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

initializeFirebase();

module.exports = {
  admin,
  db: admin.firestore(),
};
