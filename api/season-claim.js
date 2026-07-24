// api/season-claim.js
// The ONLY place allowed to grant Season Pass XP and level rewards.
// Client sends { uid, action }, server re-checks eligibility from the
// user's real data before granting anything — never trusts the client.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const LVL2_XP_REQUIRED = 100;
const EXP_PER_LEVEL = [50, 120, 250, 500, 1000];

const LVL1_REWARD = { type: 'coins', amount: 20, label: '+20 Game Coins' };
const LVL2_REWARD = { type: 'hashrate', amount: 0.23, label: 'QuantumMiner S3 (+0.23 GH/S)' };

const QUESTS = {
  quest_level2: {
    xp: 30, daily: false, label: 'Reach Account Level 2',
    check: (d, ctx) => ctx.level >= 2,
  },
  quest_owner: {
    xp: 20, daily: false, label: 'Own at least 1 Miner',
    check: (d) => (d.miner_nano || 0) + (d.miner_mega || 0) >= 1,
  },
  quest_coins: {
    xp: 25, daily: false, label: 'Reach 100 Game Coins',
    check: (d) => (d.game_coins || 0) >= 100,
  },
  quest_claims: {
    xp: 15, daily: true, label: 'Claim from Faucet 5 times today',
    check: (d, ctx) => ctx.claimsToday >= 5,
  },
  // Uses dailyLinkTs, which api/claim.js already writes whenever the
  // daily bonus link claim succeeds (action: 'daily_link'). Same UTC-date
  // comparison style as quest_claims — dailyLinkTs is a Firestore Timestamp,
  // so it's converted to a date string first.
  quest_daily_link: {
    xp: 10, daily: true, label: 'Claim the Daily Bonus Link',
    check: (d, ctx) => ctx.dailyLinkClaimedToday,
  },
};

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { uid, action } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'Missing uid' });
  if (!action) return res.status(400).json({ error: 'Missing action' });

  const db = initFirebase();
  const userRef = db.collection('users').doc(uid);

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw { code: 'NO_USER', message: 'User not found. Please sign in again.' };

      const d = snap.data();
      const today = new Date().toISOString().slice(0, 10);
      const claimsToday = d.claimsDay === today ? (d.claimsToday || 0) : 0;
      const level = getLevel(d.exp || 0);

      // dailyLinkTs is a Firestore Timestamp set by api/claim.js — convert
      // to the same UTC date-string format used everywhere else to check
      // "claimed today".
      const dailyLinkMs = d.dailyLinkTs?.toMillis ? d.dailyLinkTs.toMillis() : 0;
      const dailyLinkDateKey = dailyLinkMs ? new Date(dailyLinkMs).toISOString().slice(0, 10) : null;
      const dailyLinkClaimedToday = dailyLinkDateKey === today;

      const ctx = { level, claimsToday, dailyLinkClaimedToday };
      const seasonXp = d.season_xp || 0;

      const updates = {};
      let extra = {};

      if (action === 'lvl1') {
        if (d.season_lvl1_claimed) throw { code: 'ALREADY_CLAIMED', message: 'Already claimed.' };
        updates.season_lvl1_claimed = true;
        updates.game_coins = (d.game_coins || 0) + LVL1_REWARD.amount;
        extra = { reward: LVL1_REWARD };

      } else if (action === 'lvl2') {
        if (d.season_lvl2_claimed) throw { code: 'ALREADY_CLAIMED', message: 'Already claimed.' };
        if (seasonXp < LVL2_XP_REQUIRED) {
          throw { code: 'NOT_ENOUGH_XP', message: `Need ${LVL2_XP_REQUIRED} Season XP, you have ${seasonXp}.` };
        }
        updates.season_lvl2_claimed = true;
        updates.season_bonus_hashrate = Math.round(((d.season_bonus_hashrate || 0) + LVL2_REWARD.amount) * 100) / 100;
        extra = { reward: LVL2_REWARD };

      } else if (QUESTS[action]) {
        const q = QUESTS[action];
        const claimedField = 'season_' + action + '_claimed';
        const claimedDateField = 'season_' + action + '_date';

        if (q.daily) {
          if (d[claimedDateField] === today) throw { code: 'ALREADY_CLAIMED_TODAY', message: 'Already claimed today.' };
        } else if (d[claimedField]) {
          throw { code: 'ALREADY_CLAIMED', message: 'Already claimed.' };
        }
        if (!q.check(d, ctx)) throw { code: 'NOT_ELIGIBLE', message: 'Quest requirements not met yet.' };

        if (q.daily) updates[claimedDateField] = today;
        else updates[claimedField] = true;
        updates.season_xp = seasonXp + q.xp;
        extra = { xpGained: q.xp };

      } else {
        throw { code: 'UNKNOWN_ACTION', message: 'Unknown action.' };
      }

      tx.set(userRef, updates, { merge: true });

      return {
        season_xp: updates.season_xp ?? seasonXp,
        game_coins: updates.game_coins ?? d.game_coins ?? 0,
        season_bonus_hashrate: updates.season_bonus_hashrate ?? d.season_bonus_hashrate ?? 0,
        ...extra,
      };
    });

    return res.status(200).json({ success: true, ...result });

  } catch (e) {
    if (['NO_USER', 'ALREADY_CLAIMED', 'ALREADY_CLAIMED_TODAY', 'NOT_ENOUGH_XP', 'NOT_ELIGIBLE', 'UNKNOWN_ACTION'].includes(e.code)) {
      return res.status(400).json({ success: false, error: e.message, code: e.code });
    }
    console.error('Season-claim error:', e.message || e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

