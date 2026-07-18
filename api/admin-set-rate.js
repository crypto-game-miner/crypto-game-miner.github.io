// api/admin-set-rate.js
// The ONLY place allowed to change stats/global.usdt_pool / ltc_pool —
// the daily coin budgets that api/sync-mining.js divides across whoever's
// actively mining that track. Password-protected like api/moderate-ad.js.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'kr1stal2024';

function initFirebase() {
  if (!getApps().length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

// Accepts a number, or null/empty/undefined meaning "no pool — fall back
// to the flat base rate instead of dividing a budget".
function parsePool(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = parseFloat(val);
  if (!isFinite(n) || n < 0) return undefined; // invalid
  return n;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { secret, usdtPool, ltcPool } = req.body || {};
  if (secret !== ADMIN_SECRET) {
    return res.status(403).json({ success: false, error: 'Invalid admin password' });
  }

  const usdt = parsePool(usdtPool);
  const ltc  = parsePool(ltcPool);
  if (usdt === undefined || ltc === undefined) {
    return res.status(400).json({ success: false, error: 'Pools must be non-negative numbers, or blank to disable.' });
  }

  const db = initFirebase();
  try {
    await db.collection('stats').doc('global').set({
      usdt_pool: usdt,
      ltc_pool: ltc,
      poolsUpdatedAt: Timestamp.now(),
    }, { merge: true });
    return res.status(200).json({ success: true, usdt_pool: usdt, ltc_pool: ltc });
  } catch (e) {
    console.error('Admin-set-rate error:', e.message || e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

