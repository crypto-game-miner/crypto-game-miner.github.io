import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Debug: show raw env value
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    return res.status(500).json({ error: 'FIREBASE_SERVICE_ACCOUNT is missing' });
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch(e) {
    return res.status(500).json({ 
      error: 'JSON parse failed: ' + e.message,
      rawStart: raw.substring(0, 50),
      rawEnd: raw.substring(raw.length - 20),
      length: raw.length
    });
  }

  try {
    if (!getApps().length) {
      initializeApp({ credential: cert(serviceAccount) });
    }
    const db = getFirestore();
    await db.collection('test').doc('ping').set({ ok: true });
    return res.status(200).json({ success: true });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
