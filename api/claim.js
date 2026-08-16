// api/claim.js
// The ONLY place that's allowed to credit USDT/Game coins for a faucet claim.
// Also the only place allowed to consume a view from an active purchased
// ad_slots document. Client sends { uid, adVerified } for a faucet claim
// (adVerified: whether a real ad view was confirmed — false means adblock
// was detected, so the claim still counts but no USDT Coins are granted),
// or { uid, action: 'daily_link' } for the daily bonus-link claim.
//
// Also tracks a daily claim streak: the first faucet claim of a calendar
// day (UTC) bumps claimStreak by 1 (capped at CLAIM_STREAK_CAP_DAYS), as
// long as the previous streak day was exactly yesterday. Any gap of a
// full missed day resets claimStreak back to 1. Further claims on the
// same day don't increment it again. claimStreak feeds a +1%/day mining
// power bonus on the client (home.html), capped at +30%.

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
// set) but hasn't set claim_pool_decay_pct / claim_pool_start_reward.
const DEFAULT_CLAIM_POOL_DECAY_PCT = 2;
const DEFAULT_CLAIM_POOL_START_REWARD = 7; // what the very first claim of the day pays, before decay
const MIN_POOL_REWARD = 0.01; // never let the per-claim reward round down to literally zero
const MAX_POOL_REWARD_CEILING = 7; // absolute hard ceiling regardless of admin's starting-reward setting

// Daily claim streak (mining power bonus, applied client-side).
const CLAIM_STREAK_CAP_DAYS = 30; // +1%/day, capped at +30%

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

// Returns the UTC date key (YYYY-MM-DD) that is `days` days after dateKey.
function addDaysKey(dateKey, days) {
  const d = new Date(dateKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { uid, action, adVerified } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'Missing uid' });

  // Whether this claim is backed by a confirmed ad view. Defaults to true
  // so any older client that doesn't send this field (or the daily-link
  // flow, which doesn't use it at all) keeps the previous behavior.
  const adWasVerified = adVerified !== false;

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
  // and an adblock-aware USDT reward.
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

      // ─── Daily claim streak ──────────────────────────────────────────
      // Only the FIRST claim of a calendar day (UTC) affects the streak.
      // If the last streak day was exactly yesterday, bump it (capped).
      // If it was today already, leave it unchanged. Any bigger gap (a
      // full day with zero claims) resets the streak back to 1.
      const prevStreakDay = data.claimStreakDay || null;
      let claimStreak = data.claimStreak || 0;
      if (prevStreakDay === today) {
        // already counted today — no change
      } else if (prevStreakDay && addDaysKey(prevStreakDay, 1) === today) {
        claimStreak = Math.min(claimStreak + 1, CLAIM_STREAK_CAP_DAYS);
      } else {
        claimStreak = 1;
      }

      // ─── Determine USDT reward ───────────────────────────────────────
      // If adVerified is false (adblock detected client-side), the claim
      // still goes through — game coins / EXP / hashrate boost are still
      // granted below — but USDT Coins are withheld entirely, and the
      // claim pool (if enabled) is left untouched since no budget was
      // actually spent.
      //
      // When adVerified is true, two modes apply:
      // 1. Flat (default): guest/logged fixed reward, unlimited.
      // 2. Declining pool (opt-in via claim_pool_usdt): a shared, site-wide
      //    daily budget. Tracks the CURRENT per-claim reward directly (not
      //    a % of remaining budget, which would stay flat at the ceiling
      //    for a long stretch when the budget is large). The first claim
      //    of the day pays the admin's configured starting reward (capped
      //    at MAX_POOL_REWARD_CEILING and at the budget itself, whichever
      //    is smaller), then multiplies by (1 - decayPct/100) after every
      //    single claim — so the reward decreases visibly from the very
      //    first claim. The remaining budget is a separate hard stop —
      //    once it hits 0, further claims (that day) get nothing from the pool.
      const isRealLogin = !!data.email; // email only set once user links Google
      const claimPoolUsdt = g.claim_pool_usdt != null ? g.claim_pool_usdt : null;
      let usdtReward = 0;
      let poolUpdate = null;

      if (adWasVerified) {
        if (claimPoolUsdt != null) {
          const decayPct = g.claim_pool_decay_pct != null ? g.claim_pool_decay_pct : DEFAULT_CLAIM_POOL_DECAY_PCT;
          const startReward = g.claim_pool_start_reward != null ? g.claim_pool_start_reward : DEFAULT_CLAIM_POOL_START_REWARD;
          const poolDay = g.claim_pool_day;
          const isFreshDay = poolDay !== today || g.claim_pool_remaining == null || g.claim_pool_current_reward == null;

          const remaining = isFreshDay ? claimPoolUsdt : g.claim_pool_remaining;
          const currentReward = isFreshDay
            ? Math.min(claimPoolUsdt, startReward, MAX_POOL_REWARD_CEILING)
            : g.claim_pool_current_reward;

          usdtReward = Math.max(Math.min(remaining, currentReward), remaining > 0 ? MIN_POOL_REWARD : 0);
          const newRemaining = Math.max(0, Math.round((remaining - usdtReward) * 1e6) / 1e6);
          const newCurrentReward = Math.max(currentReward * (1 - decayPct / 100), MIN_POOL_REWARD);
          poolUpdate = {
            claim_pool_remaining: newRemaining,
            claim_pool_current_reward: newCurrentReward,
            claim_pool_day: today,
          };
        } else {
          usdtReward = isRealLogin ? rewardLogged : rewardGuest;
        }
      }

      // ─── Update claim boosts array (each claim = +claimBoostAmount GH/s for 24h) ─
      // Granted regardless of adVerified — only the USDT reward is gated.
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
        claimStreak: claimStreak,
        claimStreakDay: today,
        updatedAt: Timestamp.fromMillis(now),
      }, { merge: true });

      // Write back the pool's remaining budget + next per-claim reward,
      // if pool mode is active and a reward was actually granted.
      if (poolUpdate) {
        tx.set(statsGlobalRef, poolUpdate, { merge: true });
      }

      // Daily site-wide stats — how much USDT is being handed out via claims today.
      // Skipped entirely when no USDT was granted (adblock claim).
      if (usdtReward > 0) {
        const dailyStatsRef = db.collection('stats').doc('daily_' + today);
        tx.set(dailyStatsRef, {
          usdt_from_claims: FieldValue.increment(usdtReward),
          updatedAt: Timestamp.fromMillis(now),
        }, { merge: true });
      }

      // ─── Consume a view from a purchased ad slot, if this claim number
      // falls on one of the ad windows ─────────────────────────────────
      // newClaims is this user's Nth claim TODAY (1-indexed). Position 0
      // = the oldest active campaign, shown on claims 2 & 7. Position 1 =
      // the next campaign in line, shown on claims 3 & 8. And so on, up
      // to MAX_CONCURRENT_ADS. All other claim numbers show zerads.
      // Uses slotSnap read earlier (before any writes). Wrapped so that
      // any failure here never blocks the coin reward above. Sponsored
      // slots are always shown via a direct <img>, so adWasVerified is
      // always true whenever a sponsored ad was actually displayed —
      // this consumption isn't gated separately.
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
        adVerified: adWasVerified,
        gameCoinsReward,
        claimStreak,
        streakBonusPct: claimStreak, // 1 day = 1%, capped at CLAIM_STREAK_CAP_DAYS
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






