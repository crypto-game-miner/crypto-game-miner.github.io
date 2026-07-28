// api/claim.js
// The ONLY place that's allowed to credit USDT/Game coins for a faucet claim.
// Also the only place allowed to consume a view from an active purchased
// ad_slots document. Client sends { uid } for a faucet claim, or
// { uid, action: 'daily_link' } for the daily bonus-link claim.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

const MAX_CLAIMS_PER_DAY = 20;
const CLAIM_COOLDOWN_MS  = 5000;
const MAX_CONCURRENT_ADS = 5;         // campaign #1 shows on claims 2&7, #2 on 3&8, #3 on 4&9, #4 on 5&10, #5 on 6&11
const AD_CLAIM_BASE_A    = 2;         // first window start (2,3,4,5,6)
const AD_CLAIM_BASE_B    = 7;         // second window start (7,8,9,10,11)
const USDT_REWARD_GUEST  = 4;
const USDT_REWARD_LOGGED = 5;         // for users who linked a real (non-anonymous) provider
// Fallback defaults — used only if the admin hasn't set these in stats/global yet.
const DEFAULT_GAME_COINS_REWARD  = 7;
const DEFAULT_CLAIM_BOOST_AMOUNT = 0.1; // GH/s per claim, expires in 24h
const EXP_REWARD         = 8;

const DAILY_LINK_BOOST_AMOUNT = 0.17; // +0.17 GH/s for 24h, once per day
const DAILY_LINK_COOLDOWN_MS  = 86400000; // 24h

// Claim pool defaults — used only if the admin enables a pool (claim_pool_usdt
// set) but hasn't set claim_pool_decay_pct / claim_pool_max_reward.
const DEFAULT_CLAIM_POOL_DECAY_PCT = 2;
const DEFAULT_CLAIM_POOL_MAX_REWARD = 7; // hard cap per claim, regardless of how much % of pool that would be
const MIN_POOL_REWARD = 0.01; // never round a live claim reward down to literally zero

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

  const { uid, action } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'Missing uid' });

  const db = initFirebase();
  const userRef = db.collection('users').doc(uid);

  // ─────────────────────────────────────────────────────────────────
  // DAILY LINK CLAIM — separate flow, doesn't touch faucet claim
  // counters/cooldown, doesn't consume ad_slots, doesn't reward
  // coins/exp. Just a 24h-gated hashrate boost.
  // ─────────────────────────────────────────────────────────────────
  if (action === 'daily_link') {
    try {
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        const data = snap.exists ? snap.data() : {};
        const now = Date.now();

        const lastLinkTs = data.dailyLinkTs?.toMillis ? data.dailyLinkTs.toMillis() : 0;
        if (lastLinkTs && now - lastLinkTs < DAILY_LINK_COOLDOWN_MS) {
          const hoursLeft = Math.ceil((DAILY_LINK_COOLDOWN_MS - (now - lastLinkTs)) / 3600000);
          throw { code: 'LINK_COOLDOWN', message: `Come back in ${hoursLeft}h.` };
        }

        let boosts = data.claimBoosts || [];
        boosts = boosts.filter(b => now - (b.time?.toMillis ? b.time.toMillis() : b.time) < 86400000);
        boosts.push({ time: now, amount: DAILY_LINK_BOOST_AMOUNT });

        tx.set(userRef, {
          claimBoosts: boosts,
          dailyLinkTs: Timestamp.fromMillis(now),
          updatedAt: Timestamp.fromMillis(now),
        }, { merge: true });

        return { boostAmount: DAILY_LINK_BOOST_AMOUNT };
      });

      return res.status(200).json({ success: true, ...result });

    } catch (e) {
      if (e.code === 'LINK_COOLDOWN') {
        return res.status(429).json({ success: false, error: e.message, code: e.code });
      }
      console.error('Daily link claim error:', e.message || e);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // FAUCET CLAIM — original flow, now with an optional declining pool
  // ─────────────────────────────────────────────────────────────────

  // Up to 5 concurrent active campaigns can run at once. They're ordered
  // oldest-first, and that order determines which pair of daily claim
  // numbers each one occupies (see MAX_CONCURRENT_ADS below). When the
  // oldest one runs out of views it disappears from this query, and the
  // next one automatically shifts up to take its position — no extra
  // bookkeeping field needed.
  const adSlotQuery = db.collection('ad_slots')
    .where('status', '==', 'active')
    .orderBy('createdAt', 'asc')
    .limit(5);

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const data = snap.exists ? snap.data() : {};

      // Admin-adjustable claim reward amounts — read here (before any
      // writes) so budget stays controllable from admin.html, just like
      // the mining pools. Falls back to the flat defaults if unset.
      const statsGlobalRef = db.collection('stats').doc('global');
      const statsGlobalSnap = await tx.get(statsGlobalRef);
      const g = statsGlobalSnap.exists ? statsGlobalSnap.data() : {};
      const rewardGuest  = g.usdt_reward_guest  != null ? g.usdt_reward_guest  : USDT_REWARD_GUEST;
      const rewardLogged = g.usdt_reward_logged != null ? g.usdt_reward_logged : USDT_REWARD_LOGGED;
      const gameCoinsReward  = g.game_coins_reward  != null ? g.game_coins_reward  : DEFAULT_GAME_COINS_REWARD;
      const claimBoostAmount = g.claim_boost_amount != null ? g.claim_boost_amount : DEFAULT_CLAIM_BOOST_AMOUNT;

      // Read the ad slot query up front too — Firestore transactions
      // require ALL reads to happen before ANY writes.
      let slotSnap = null;
      try {
        slotSnap = await tx.get(adSlotQuery);
      } catch (adErr) {
        console.error('Ad slot lookup failed (claim still succeeds):', adErr.message || adErr);
      }

      const now = Date.now();

      // ─── Daily claim limit (server-side, based on stored date) ──────
      // Uses a UTC date key (YYYY-MM-DD) instead of toDateString(), so it
      // matches regardless of the server's or the client's local timezone.
      const today = new Date().toISOString().slice(0, 10);
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

      // ─── Determine reward ───────────────────────────────────────────
      // Two modes:
      // 1. Flat (default): guest/logged fixed reward, unlimited.
      // 2. Declining pool (opt-in via claim_pool_usdt): a shared, site-wide
      //    daily budget that depletes as ANY user claims — each claim pays
      //    out a % of whatever's left, so early claims of the day pay more
      //    and it tapers off as the day goes on. Capped at claim_pool_max_reward
      //    per claim regardless of how much % of the pool that would be.
      //    Resets to the full budget at the start of each UTC day.
      const isRealLogin = !!data.email; // email only set once user links Google
      const claimPoolUsdt = g.claim_pool_usdt != null ? g.claim_pool_usdt : null;
      let usdtReward;
      let poolUpdate = null;

      if (claimPoolUsdt != null) {
        const decayPct = g.claim_pool_decay_pct != null ? g.claim_pool_decay_pct : DEFAULT_CLAIM_POOL_DECAY_PCT;
        const maxReward = g.claim_pool_max_reward != null ? g.claim_pool_max_reward : DEFAULT_CLAIM_POOL_MAX_REWARD;
        const poolDay = g.claim_pool_day;
        const remaining = (poolDay === today && g.claim_pool_remaining != null)
          ? g.claim_pool_remaining
          : claimPoolUsdt; // fresh day (or first-ever claim) — reset to full budget
        const rawReward = Math.max(remaining * (decayPct / 100), MIN_POOL_REWARD);
        usdtReward = Math.min(remaining, rawReward, maxReward);
        const newRemaining = Math.max(0, Math.round((remaining - usdtReward) * 1e6) / 1e6);
        poolUpdate = { claim_pool_remaining: newRemaining, claim_pool_day: today };
      } else {
        usdtReward = isRealLogin ? rewardLogged : rewardGuest;
      }

      // ─── Update claim boosts array (each claim = +claimBoostAmount GH/s for 24h) ─
      let boosts = data.claimBoosts || [];
      boosts = boosts.filter(b => now - (b.time?.toMillis ? b.time.toMillis() : b.time) < 86400000);
      boosts.push({ time: now, amount: claimBoostAmount });

      const newCoins     = (data.coins || 0) + usdtReward;
      const newGameCoins = (data.game_coins || 0) + gameCoinsReward;
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

      // Write back the pool's remaining budget, if pool mode is active.
      if (poolUpdate) {
        tx.set(statsGlobalRef, poolUpdate, { merge: true });
      }

      // Daily site-wide stats — how much USDT is being handed out via claims today.
      const dailyStatsRef = db.collection('stats').doc('daily_' + today);
      tx.set(dailyStatsRef, {
        usdt_from_claims: FieldValue.increment(usdtReward),
        updatedAt: Timestamp.fromMillis(now),
      }, { merge: true });

      // ─── Consume a view from a purchased ad slot, if this claim number
      // falls on one of the ad windows ─────────────────────────────────
      // newClaims is this user's Nth claim TODAY (1-indexed). Position 0
      // = the oldest active campaign, shown on claims 2 & 7. Position 1 =
      // the next campaign in line, shown on claims 3 & 8. And so on, up
      // to MAX_CONCURRENT_ADS. All other claim numbers show zerads.
      // Uses slotSnap read earlier (before any writes). Wrapped so that
      // any failure here never blocks the coin reward above.
      let ad = null;
      try {
        let adPosition = null;
        if (newClaims >= AD_CLAIM_BASE_A && newClaims < AD_CLAIM_BASE_A + MAX_CONCURRENT_ADS) {
          adPosition = newClaims - AD_CLAIM_BASE_A;
        } else if (newClaims >= AD_CLAIM_BASE_B && newClaims < AD_CLAIM_BASE_B + MAX_CONCURRENT_ADS) {
          adPosition = newClaims - AD_CLAIM_BASE_B;
        }

        if (adPosition !== null && slotSnap && slotSnap.docs.length > adPosition) {
          const slotDoc  = slotSnap.docs[adPosition];
          const slotData = slotDoc.data();
          const newViewsShown = (slotData.views_shown || 0) + 1;
          const exhausted = newViewsShown >= slotData.views_total;

          tx.update(slotDoc.ref, {
            views_shown: newViewsShown,
            status: exhausted ? 'completed' : 'active',
          });

          ad = {
            banner_url: slotData.banner_url,
            click_url: slotData.click_url,
          };
        }
      } catch (adErr) {
        console.error('Ad slot update failed (claim still succeeds):', adErr.message || adErr);
      }

      return {
        coins: newCoins,
        game_coins: newGameCoins,
        exp: newExp,
        claimsToday: newClaims,
        claimsRemaining: MAX_CLAIMS_PER_DAY - newClaims,
        usdtReward,
        gameCoinsReward,
        ad,
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




