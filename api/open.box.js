// api/open-box.js
// The ONLY place allowed to deduct game_coins and roll a Mystery Box prize.
// The RNG roll happens here (server), never on the client, so the odds
// can't be tampered with. Client sends just { uid }.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PRICE = 40;
const MAX_MEGA = 2;
const HASHRATE_PER_MEGA = 0.2;

function initFirebase() {
  if (!getApps().length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

function rollPrize() {
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

  const { uid } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'Missing uid' });

  const db = initFirebase();
  const userRef = db.collection('users').doc(uid);

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw { code: 'NO_USER', message: 'User not found. Please sign in again.' };

      const data = snap.data();
      const ownedMega = data.miner_mega || 0;
      const gameCoins = data.game_coins || 0;

      if (ownedMega >= MAX_MEGA) {
        throw { code: 'MAXED', message: `You already own the max (${MAX_MEGA}) MegaMiners.` };
      }
      if (gameCoins < PRICE) {
        throw { code: 'INSUFFICIENT_FUNDS', message: `Not enough Game Coins. Need ${PRICE}, you have ${gameCoins}.` };
      }

      // Cost is paid regardless of the prize rolled.
      let newGameCoins = gameCoins - PRICE;
      let newOwnedMega = ownedMega;
      let newTaskBonus = data.task_bonus_hashrate || 0;

      const prize = rollPrize();

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

      return {
        prize,
        game_coins: newGameCoins,
        miner_mega: newOwnedMega,
        task_bonus_hashrate: newTaskBonus,
      };
    });

    return res.status(200).json({ success: true, ...result });

  } catch (e) {
    if (e.code === 'NO_USER' || e.code === 'MAXED' || e.code === 'INSUFFICIENT_FUNDS') {
      return res.status(400).json({ success: false, error: e.message, code: e.code });
    }
    console.error('Open-box error:', e.message || e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

