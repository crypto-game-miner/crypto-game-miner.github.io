// api/test-firebase.js - using single JSON env variable
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function initFirebase() {
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const db = initFirebase();
    await db.collection('test').doc('ping').set({ test: true, time: new Date().toISOString() });
    return res.status(200).json({ success: true, message: 'Firebase Admin SDK works!' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}

