// api/claim.js
// The ONLY place that's allowed to credit USDT/Game coins for a faucet claim.
// Client sends just { uid }, server decides everything else.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

const MAX_CLAIMS_PER_DAY = 20;
const CLAIM_COOLDOWN_MS  = 5000;
const CLAIM_BOOST_AMOUNT = 0.1;       // +0.1 GH/s per claim, expires in 24h
const USDT_REWARD_GUEST  = 4;
const USDT_REWARD_LOGGED = 5;         // for users who linked a real (non-anonymous) provider
const GAME_COINS_REWARD  = 7;
const EXP_REWARD         = 8;

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

  const { uid } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'Missing uid' });

  const db = initFirebase();
  const userRef = db.collection('users').doc(uid);

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const data = snap.exists ? snap.data() : {};

      const now = Date.now();

      // ─── Daily claim limit (server-side, based on stored date) ──────
      const today = new Date().toDateString();
      let claimsToday = data.claimsToday || 0;
      if (data.claimsDay !== today) {
        claimsToday = 0;
      }
      if (claimsToday >= MAX_CLAIMS_PER_DAY) {
        throw { code: 'LIMIT', message: 'Daily claim limit reached. Come back tomorrow.' };
      }

      // ─── Cooldown ─────────────────────────────────────────────────
      const lastClaimTs = data.lastClaimTs?.toMillis ? data.lastClaimTs.toMillis() : 0;
      if (lastClaimTs && now - lastClaimTs < CLAIM_COOLDOWN_MS) {
        const wait = Math.ceil((CLAIM_COOLDOWN_MS - (now - lastClaimTs)) / 1000);
        throw { code: 'COOLDOWN', message: `Please wait ${wait}s before next claim.` };
      }

      // ─── Determine reward (real login = signed in with Google, not anonymous) ──
      const isRealLogin = !!data.email; // email only set once user links Google
      const usdtReward = isRealLogin ? USDT_REWARD_LOGGED : USDT_REWARD_GUEST;

      // ─── Update claim boosts array (each claim = +0.1 GH/s for 24h) ─
      let boosts = data.claimBoosts || [];
      boosts = boosts.filter(b => now - (b.time?.toMillis ? b.time.toMillis() : b.time) < 86400000);
      boosts.push({ time: now, amount: CLAIM_BOOST_AMOUNT });

      const newCoins     = (data.coins || 0) + usdtReward;
      const newGameCoins = (data.game_coins || 0) + GAME_COINS_REWARD;
      const newExp       = (data.exp || 0) + EXP_REWARD;
      const newClaims    = claimsToday + 1;

      tx.set(userRef, {
        coins: newCoins,
        game_coins: newGameCoins,
        exp: newExp,
        claimsToday: newClaims,
        claimsDay: today,
        lastClaimTs: Timestamp.fromMillis(now),
        lastClaimTime: Timestamp.fromMillis(now),
        claimBoosts: boosts,
        updatedAt: Timestamp.fromMillis(now),
      }, { merge: true });

      return {
        coins: newCoins,
        game_coins: newGameCoins,
        exp: newExp,
        claimsToday: newClaims,
        claimsRemaining: MAX_CLAIMS_PER_DAY - newClaims,
        usdtReward,
        gameCoinsReward: GAME_COINS_REWARD,
      };
    });

    return res.status(200).json({ success: true, ...result });

  } catch (e) {
    if (e.code === 'LIMIT' || e.code === 'COOLDOWN') {
      return res.status(429).json({ success: false, error: e.message, code: e.code });
    }
    console.error('Claim error:', e.message || e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}
