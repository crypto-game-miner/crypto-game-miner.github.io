// api/admin-set-rate.js
// The ONLY place allowed to change stats/global.dailyRate — the payout
// multiplier applied to every user's mining earnings in api/sync-mining.js.
// Password-protected the same way as api/moderate-ad.js.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'kr1stal2024';

function initFirebase() {
  if (!getApps().length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { secret, dailyRate } = req.body || {};
  if (secret !== ADMIN_SECRET) {
    return res.status(403).json({ success: false, error: 'Invalid admin password' });
  }

  const rate = parseFloat(dailyRate);
  if (!isFinite(rate) || rate < 0 || rate > 10) {
    return res.status(400).json({ success: false, error: 'dailyRate must be a number between 0 and 10' });
  }

  const db = initFirebase();
  try {
    await db.collection('stats').doc('global').set({
      dailyRate: rate,
      dailyRateUpdatedAt: Timestamp.now(),
    }, { merge: true });
    return res.status(200).json({ success: true, dailyRate: rate });
  } catch (e) {
    console.error('Admin-set-rate error:', e.message || e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

