// api/buy-miner.js
// The ONLY place allowed to deduct game_coins and grant a NanoMiner X1.
// Client sends just { uid }, server verifies balance/max and does
// everything in a transaction via Admin SDK (bypasses Firestore rules
// that block clients from writing game_coins/hashrate-related fields).

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PRICE = 50;
const MAX_NANO = 10;
const HASHRATE_PER_NANO = 0.1;

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

  const { uid } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'Missing uid' });

  const db = initFirebase();
  const userRef = db.collection('users').doc(uid);

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw { code: 'NO_USER', message: 'User not found. Please sign in again.' };

      const data = snap.data();
      const ownedNano  = data.miner_nano || 0;
      const gameCoins  = data.game_coins || 0;

      if (ownedNano >= MAX_NANO) {
        throw { code: 'MAXED', message: `You already own the max (${MAX_NANO}) NanoMiners.` };
      }
      if (gameCoins < PRICE) {
        throw { code: 'INSUFFICIENT_FUNDS', message: `Not enough Game Coins. Need ${PRICE}, you have ${gameCoins}.` };
      }

      const newGameCoins = gameCoins - PRICE;
      const newOwnedNano = ownedNano + 1;
      const newTaskBonus = Math.round(((data.task_bonus_hashrate || 0) + HASHRATE_PER_NANO) * 10) / 10;

      tx.set(userRef, {
        game_coins: newGameCoins,
        miner_nano: newOwnedNano,
        task_bonus_hashrate: newTaskBonus,
      }, { merge: true });

      return { game_coins: newGameCoins, miner_nano: newOwnedNano, task_bonus_hashrate: newTaskBonus };
    });

    return res.status(200).json({ success: true, ...result });

  } catch (e) {
    if (e.code === 'NO_USER' || e.code === 'MAXED' || e.code === 'INSUFFICIENT_FUNDS') {
      return res.status(400).json({ success: false, error: e.message, code: e.code });
    }
    console.error('Buy-miner error:', e.message || e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

