// api/sync-mining.js
// Called periodically (e.g. every page load + every 60s while active) to
// credit mining earnings based on elapsed server time. The client cannot
// fake elapsed time because we use Firestore's own timestamp as the anchor.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

const LTC_RATE_PER_GH  = 2.5;  // LTC Coins per GH/s per hour
const USDT_RATE_PER_GH = 1.1;  // USDT Coins per GH/s per hour
const MAX_OFFLINE_SECONDS = 86400; // cap earnings at 24h even if away longer
const EXP_PER_LEVEL = [50, 120, 250, 500, 1000];

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

function getLevel(exp) {
  let level = 1, totalExp = 0;
  for (let i = 0; i < EXP_PER_LEVEL.length; i++) {
    if (exp >= totalExp + EXP_PER_LEVEL[i]) { totalExp += EXP_PER_LEVEL[i]; level++; }
    else return level;
  }
  return level;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { uid, miningCoin } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'Missing uid' });
  const coin = miningCoin === 'usdt' ? 'usdt' : 'ltc'; // default ltc

  const db = initFirebase();
  const userRef = db.collection('users').doc(uid);

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw { code: 'NO_USER', message: 'User not found' };

      const data = snap.data();
      const now = Date.now();

      // ─── Determine if mining is active ───────────────────────────
      const lastClaimMs = data.lastClaimTime?.toMillis ? data.lastClaimTime.toMillis() : 0;
      const hoursSinceClaim = (now - lastClaimMs) / 1000 / 3600;
      const miningPaused = lastClaimMs === 0 || hoursSinceClaim > 24;

      const exp = data.exp || 0;
      const level = getLevel(exp);
      const baseHashrate = level >= 2 ? 0.5 : 0;
      const taskBonus = data.task_bonus_hashrate || 0;
      const permHashrate = Math.round((baseHashrate + taskBonus) * 10) / 10;

      const claimBoosts = (data.claimBoosts || []).filter(b => {
        const t = b.time?.toMillis ? b.time.toMillis() : b.time;
        return now - t < 86400000;
      });
      const boostTotal = Math.round(claimBoosts.reduce((s, b) => s + b.amount, 0) * 10) / 10;
      const totalHashrate = Math.round((permHashrate + boostTotal) * 10) / 10;

      // ─── Anchor: last time we synced mining for this user ────────
      const lastSyncMs = data.lastMiningSync?.toMillis ? data.lastMiningSync.toMillis() : now;
      const secondsElapsed = Math.min(Math.max((now - lastSyncMs) / 1000, 0), MAX_OFFLINE_SECONDS);

      let earned = 0;
      const updates = {
        lastMiningSync: Timestamp.fromMillis(now),
        claimBoosts, // write back the filtered (non-expired) list
      };

      if (!miningPaused && totalHashrate > 0 && secondsElapsed > 0) {
        const rate = coin === 'usdt' ? USDT_RATE_PER_GH : LTC_RATE_PER_GH;
        earned = totalHashrate * rate / 3600 * secondsElapsed;

        if (coin === 'usdt') {
          updates.coins = (data.coins || 0) + earned;
        } else {
          updates.ltc = (data.ltc || 0) + earned;
        }
      }

      tx.set(userRef, updates, { merge: true });

      return {
        earned,
        coin,
        coins: coin === 'usdt' ? (data.coins || 0) + earned : (data.coins || 0),
        ltc:   coin === 'ltc'  ? (data.ltc   || 0) + earned : (data.ltc   || 0),
        totalHashrate,
        permHashrate,
        boostTotal,
        miningPaused,
        level,
        exp,
      };
    });

    return res.status(200).json({ success: true, ...result });

  } catch (e) {
    console.error('Sync mining error:', e.message || e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}
