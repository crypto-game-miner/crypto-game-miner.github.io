// api/link-google.js
// The ONLY place allowed to write `email` to a user's doc and grant the
// one-time Google-registration hashrate bonus. Never overwrites the whole
// document (unlike the old client-side setDoc it replaces) — always merges,
// and never touches coins/game_coins/ltc/exp that the client can't write.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const REGISTER_BONUS_HASHRATE = 0.3;

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

  const { uid, email } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'Missing uid' });
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Missing/invalid email' });

  const db = initFirebase();
  const userRef = db.collection('users').doc(uid);

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const isNew = !snap.exists;
      const data = snap.exists ? snap.data() : {};

      const updates = { email, updatedAt: Timestamp.now() };
      let bonusGranted = false;

      if (isNew) {
        // Brand new account (never had a doc, e.g. first-ever sign-in with
        // no prior anonymous play) — safe defaults + the one-time bonus.
        updates.coins = 0;
        updates.game_coins = 0;
        updates.ltc = 0;
        updates.exp = 0;
        updates.miner_nano = 0;
        updates.miner_mega = 0;
        updates.task_bonus_hashrate = REGISTER_BONUS_HASHRATE;
        updates.registerBonusGiven = true;
        bonusGranted = true;
      } else if (!data.registerBonusGiven) {
        // Existing doc (e.g. carried over from anonymous play under the
        // same uid via linkWithPopup) that hasn't gotten the bonus yet.
        updates.task_bonus_hashrate = Math.round(((data.task_bonus_hashrate || 0) + REGISTER_BONUS_HASHRATE) * 10) / 10;
        updates.registerBonusGiven = true;
        bonusGranted = true;
      }
      // Otherwise: just (re)confirm the email, nothing else changes —
      // safe to call this endpoint repeatedly on every settings.html visit.

      tx.set(userRef, updates, { merge: true });

      return {
        isNew,
        bonusGranted,
        coins: updates.coins ?? data.coins ?? 0,
        game_coins: updates.game_coins ?? data.game_coins ?? 0,
        ltc: updates.ltc ?? data.ltc ?? 0,
        exp: updates.exp ?? data.exp ?? 0,
        miner_nano: updates.miner_nano ?? data.miner_nano ?? 0,
        miner_mega: updates.miner_mega ?? data.miner_mega ?? 0,
        task_bonus_hashrate: updates.task_bonus_hashrate ?? data.task_bonus_hashrate ?? 0,
        registerBonusGiven: true,
        zeradsBonusGiven: !!data.zeradsBonusGiven,
      };
    });

    return res.status(200).json({ success: true, ...result });

  } catch (e) {
    console.error('Link-google error:', e.message || e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

