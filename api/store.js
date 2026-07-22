// api/store.js
// Merges the former api/buy-miner.js and api/open-box.js into one function
// (Vercel Hobby plan caps a project at 12 serverless functions total).
// The ONLY place allowed to deduct game_coins for NanoMiner purchases and
// Mystery Box openings. Client sends { uid, action }.
//
// All prices/power/limits/odds are admin-adjustable via api/moderate-ad.js
// (action: set_store_config), stored in stats/global. Read here inside the
// transaction (before any writes) so the server always enforces whatever
// the admin panel currently shows — never trusts anything from the client
// about price/power/odds.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Fallback defaults — used only for any field the admin hasn't set yet.
const DEFAULTS = {
  nano_price: 50,
  nano_power: 0.1,
  nano_max: 10,
  box_price: 40,
  mega_power: 0.2,
  mega_max: 2,
  box_odds_tier1_chance: 35, box_odds_tier1_amount: 10,
  box_odds_tier2_chance: 30, box_odds_tier2_amount: 20,
  box_odds_tier3_chance: 15, box_odds_tier3_amount: 40,
  // mega chance = 100 - (tier1 + tier2 + tier3)
};

function initFirebase() {
  if (!getApps().length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

function getStoreConfig(g) {
  const cfg = {};
  for (const key in DEFAULTS) {
    cfg[key] = (g && g[key] != null) ? g[key] : DEFAULTS[key];
  }
  return cfg;
}

function rollBoxPrize(cfg) {
  const t1 = cfg.box_odds_tier1_chance;
  const t2 = t1 + cfg.box_odds_tier2_chance;
  const t3 = t2 + cfg.box_odds_tier3_chance;
  const r = Math.random() * 100;
  if (r < t1) return { type: 'coins', amount: cfg.box_odds_tier1_amount };
  if (r < t2) return { type: 'coins', amount: cfg.box_odds_tier2_amount };
  if (r < t3) return { type: 'coins', amount: cfg.box_odds_tier3_amount };
  return { type: 'mega' };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { uid, action } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'Missing uid' });
  if (action !== 'buy_miner' && action !== 'open_box') {
    return res.status(400).json({ error: 'Unknown action' });
  }

  const db = initFirebase();
  const userRef  = db.collection('users').doc(uid);
  const statsRef = db.collection('stats').doc('global');

  try {
    const result = await db.runTransaction(async (tx) => {
      // Firestore transactions require ALL reads before ANY writes.
      const [snap, statsSnap] = await Promise.all([tx.get(userRef), tx.get(statsRef)]);
      if (!snap.exists) throw { code: 'NO_USER', message: 'User not found. Please sign in again.' };

      const cfg = getStoreConfig(statsSnap.exists ? statsSnap.data() : {});
      const data = snap.data();
      const gameCoins = data.game_coins || 0;

      if (action === 'buy_miner') {
        const ownedNano = data.miner_nano || 0;
        if (ownedNano >= cfg.nano_max) throw { code: 'MAXED', message: `You already own the max (${cfg.nano_max}) NanoMiners.` };
        if (gameCoins < cfg.nano_price) throw { code: 'INSUFFICIENT_FUNDS', message: `Not enough Game Coins. Need ${cfg.nano_price}, you have ${gameCoins}.` };

        const newGameCoins = gameCoins - cfg.nano_price;
        const newOwnedNano = ownedNano + 1;
        const newTaskBonus = Math.round(((data.task_bonus_hashrate || 0) + cfg.nano_power) * 100) / 100;

        tx.set(userRef, {
          game_coins: newGameCoins,
          miner_nano: newOwnedNano,
          task_bonus_hashrate: newTaskBonus,
        }, { merge: true });

        return { game_coins: newGameCoins, miner_nano: newOwnedNano, task_bonus_hashrate: newTaskBonus };
      }

      // action === 'open_box'
      const ownedMega = data.miner_mega || 0;
      if (ownedMega >= cfg.mega_max) throw { code: 'MAXED', message: `You already own the max (${cfg.mega_max}) MegaMiners.` };
      if (gameCoins < cfg.box_price) throw { code: 'INSUFFICIENT_FUNDS', message: `Not enough Game Coins. Need ${cfg.box_price}, you have ${gameCoins}.` };

      let newGameCoins = gameCoins - cfg.box_price;
      let newOwnedMega = ownedMega;
      let newTaskBonus = data.task_bonus_hashrate || 0;

      const prize = rollBoxPrize(cfg);
      if (prize.type === 'coins') {
        newGameCoins += prize.amount;
      } else {
        newOwnedMega += 1;
        newTaskBonus = Math.round((newTaskBonus + cfg.mega_power) * 100) / 100;
      }

      tx.set(userRef, {
        game_coins: newGameCoins,
        miner_mega: newOwnedMega,
        task_bonus_hashrate: newTaskBonus,
      }, { merge: true });

      return { prize, game_coins: newGameCoins, miner_mega: newOwnedMega, task_bonus_hashrate: newTaskBonus };
    });

    return res.status(200).json({ success: true, ...result });

  } catch (e) {
    if (['NO_USER', 'MAXED', 'INSUFFICIENT_FUNDS'].includes(e.code)) {
      return res.status(400).json({ success: false, error: e.message, code: e.code });
    }
    console.error('Store error:', e.message || e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

