// api/store.js
// Merges the former api/buy-miner.js and api/open-box.js into one function
// (Vercel Hobby plan caps a project at 12 serverless functions total).
// The ONLY place allowed to deduct game_coins for NanoMiner purchases and
// Mystery Box openings. Client sends { uid, action }.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const NANO_PRICE = 50;
const MAX_NANO = 10;
const HASHRATE_PER_NANO = 0.1;

const BOX_PRICE = 40;
const MAX_MEGA = 2;
const HASHRATE_PER_MEGA = 0.2;

function initFirebase() {
  if (!getApps().length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

function rollBoxPrize() {
  const r = Math.random() * 100;
  if (r < 35) return { type: 'coins', amount: 10 };
  if (r < 65) return { type: 'coins', amount: 20 };
  if (r < 80) return { type: 'coins', amount: 40 };
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
  const userRef = db.collection('users').doc(uid);

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw { code: 'NO_USER', message: 'User not found. Please sign in again.' };

      const data = snap.data();
      const gameCoins = data.game_coins || 0;

      if (action === 'buy_miner') {
        const ownedNano = data.miner_nano || 0;
        if (ownedNano >= MAX_NANO) throw { code: 'MAXED', message: `You already own the max (${MAX_NANO}) NanoMiners.` };
        if (gameCoins < NANO_PRICE) throw { code: 'INSUFFICIENT_FUNDS', message: `Not enough Game Coins. Need ${NANO_PRICE}, you have ${gameCoins}.` };

        const newGameCoins = gameCoins - NANO_PRICE;
        const newOwnedNano = ownedNano + 1;
        const newTaskBonus = Math.round(((data.task_bonus_hashrate || 0) + HASHRATE_PER_NANO) * 10) / 10;

        tx.set(userRef, {
          game_coins: newGameCoins,
          miner_nano: newOwnedNano,
          task_bonus_hashrate: newTaskBonus,
        }, { merge: true });

        return { game_coins: newGameCoins, miner_nano: newOwnedNano, task_bonus_hashrate: newTaskBonus };
      }

      // action === 'open_box'
      const ownedMega = data.miner_mega || 0;
      if (ownedMega >= MAX_MEGA) throw { code: 'MAXED', message: `You already own the max (${MAX_MEGA}) MegaMiners.` };
      if (gameCoins < BOX_PRICE) throw { code: 'INSUFFICIENT_FUNDS', message: `Not enough Game Coins. Need ${BOX_PRICE}, you have ${gameCoins}.` };

      let newGameCoins = gameCoins - BOX_PRICE;
      let newOwnedMega = ownedMega;
      let newTaskBonus = data.task_bonus_hashrate || 0;

      const prize = rollBoxPrize();
      if (prize.type === 'coins') {
        newGameCoins += prize.amount;
      } else {
        newOwnedMega += 1;
        newTaskBonus = Math.round((newTaskBonus + HASHRATE_PER_MEGA) * 10) / 10;
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

