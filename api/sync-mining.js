import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const LTC_RATE  = 2.5;
const USDT_RATE = 1.1;
const MAX_SECONDS = 86400;
const EXP_PER_LEVEL = [50, 120, 250, 500, 1000];

function initFirebase() {
  if (!getApps().length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

function getLevel(exp) {
  let level = 1, total = 0;
  for (let i = 0; i < EXP_PER_LEVEL.length; i++) {
    if (exp >= total + EXP_PER_LEVEL[i]) { total += EXP_PER_LEVEL[i]; level++; }
    else return level;
  }
  return level;
}

// Public display name that never leaks the real email — just the part
// before '@', or a stable Guest_XXXX tag derived from the uid.
function publicDisplayName(data, uid) {
  if (data.email && typeof data.email === 'string' && data.email.includes('@')) {
    return data.email.split('@')[0];
  }
  return 'Guest_' + uid.slice(-4).toUpperCase();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { uid, miningCoin } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'Missing uid' });
  const coin = miningCoin === 'usdt' ? 'usdt' : 'ltc';

  const db = initFirebase();
  const userRef = db.collection('users').doc(uid);
  const leaderboardRef = db.collection('leaderboard_public').doc(uid);

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw { code: 'NO_USER' };

      const data = snap.data();
      const now = Date.now();

      const lastClaimMs = data.lastClaimTime?.toMillis ? data.lastClaimTime.toMillis() : 0;
      const miningPaused = lastClaimMs === 0 || (now - lastClaimMs) / 1000 / 3600 > 24;

      const level = getLevel(data.exp || 0);
      const baseHashrate = level >= 2 ? 0.5 : 0;
      const taskBonus = data.task_bonus_hashrate || 0;
      const permHashrate = Math.round((baseHashrate + taskBonus) * 10) / 10;

      const boosts = (data.claimBoosts || []).filter(b => {
        const t = b.time?.toMillis ? b.time.toMillis() : b.time;
        return now - t < 86400000;
      });
      const boostTotal = Math.round(boosts.reduce((s, b) => s + b.amount, 0) * 10) / 10;
      const totalHashrate = Math.round((permHashrate + boostTotal) * 10) / 10;

      const lastSyncMs = data.lastMiningSync?.toMillis ? data.lastMiningSync.toMillis() : now;
      const secondsElapsed = Math.min(Math.max((now - lastSyncMs) / 1000, 0), MAX_SECONDS);

      const updates = { lastMiningSync: Timestamp.fromMillis(now), claimBoosts: boosts };
      let earned = 0;

      if (!miningPaused && totalHashrate > 0 && secondsElapsed > 0) {
        const rate = coin === 'usdt' ? USDT_RATE : LTC_RATE;
        earned = totalHashrate * rate / 3600 * secondsElapsed;
        if (coin === 'usdt') updates.coins = (data.coins || 0) + earned;
        else updates.ltc = (data.ltc || 0) + earned;
      }

      tx.set(userRef, updates, { merge: true });

      // ─── Mirror safe, public-only fields for the leaderboard ────────
      // Never write email, coins, ltc, or anything sensitive here — this
      // collection is publicly readable by design.
      tx.set(leaderboardRef, {
        display_name: publicDisplayName(data, uid),
        hashrate: totalHashrate,
        level,
        miner_nano: data.miner_nano != null
          ? data.miner_nano
          : Math.max(0, Math.round((totalHashrate - 1.0) / 0.1)),
        is_active: !miningPaused,
        updatedAt: Timestamp.fromMillis(now),
      }, { merge: true });

      return {
        earned,
        coin,
        coins: coin === 'usdt' ? (data.coins || 0) + earned : (data.coins || 0),
        ltc:   coin === 'ltc'  ? (data.ltc   || 0) + earned : (data.ltc   || 0),
        totalHashrate,
        miningPaused,
        level,
      };
    });

    return res.status(200).json({ success: true, ...result });
  } catch (e) {
    console.error('Sync mining error:', e.message || e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

