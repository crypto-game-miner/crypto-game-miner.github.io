// api/track-view.js
// Increments the "views" counter on an ad_slots document. Called by
// home.html once per user per ~15min (client-side throttle) whenever
// a paid banner is actually shown. Uses firebase-admin so it works
// regardless of client Firestore security rules (same pattern as
// moderate-ad.js).

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

function initFirebase() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  return getFirestore();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { slotId } = req.body || {};
  if (!slotId) return res.status(400).json({ success: false, error: 'Missing slotId' });

  const db = initFirebase();

  try {
    await db.collection('ad_slots').doc(slotId).update({
      views: FieldValue.increment(1),
    });
    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('track-view error:', e.message || e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

