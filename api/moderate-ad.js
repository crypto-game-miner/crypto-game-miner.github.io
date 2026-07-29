// api/moderate-ad.js
// The ONLY place allowed to change ad_requests status and create/delete
// ad_slots documents. admin.html calls this instead of writing to
// Firestore directly, because the security rules block client writes
// to these collections (allow update, delete: if false).

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

// No client-visible fallback anymore — this is the only place the real
// password exists, and it only lives in Vercel's env vars.
const ADMIN_SECRET = process.env.ADMIN_SECRET;

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

  if (!ADMIN_SECRET) {
    console.error('ADMIN_SECRET env var is not set');
    return res.status(500).json({ success: false, error: 'Server misconfigured' });
  }

  const {
    secret, action, reqId, views, bannerUrl, clickUrl,
    usdtPool, ltcPool, solPool, rewardGuest, rewardLogged, dailyLinkUrl,
    minUsdt, maxUsdt, minLtc, maxLtc, minSol, maxSol, storeConfig,
    gameCoinsReward, claimBoostAmount,
    baseUsdtRate, baseLtcRate, baseSolRate, swapFeePct,
    claimPoolUsdt, claimPoolDecayPct, claimPoolStartReward,
  } = req.body || {};

  if (secret !== ADMIN_SECRET) {
    return res.status(403).json({ success: false, error: 'Invalid admin password' });
  }

  const db = initFirebase();

  // Just confirms the password is correct — no side effects. Used by
  // admin.html's login screen so the real password never has to be
  // written into client-side JS to be compared there.
  if (action === 'verify') {
    return res.status(200).json({ success: true });
  }

  // set_pools doesn't touch ad_requests, so it's handled before the reqId check.
  if (action === 'set_pools') {
    function parsePool(val) {
      if (val === null || val === undefined || val === '') return null;
      const n = parseFloat(val);
      if (!isFinite(n) || n < 0) return undefined;
      return n;
    }
    const usdt = parsePool(usdtPool);
    const ltc  = parsePool(ltcPool);
    const sol  = parsePool(solPool);
    if (usdt === undefined || ltc === undefined || sol === undefined) {
      return res.status(400).json({ success: false, error: 'Pools must be non-negative numbers, or blank to disable.' });
    }
    try {
      await db.collection('stats').doc('global').set({
        usdt_pool: usdt,
        ltc_pool: ltc,
        sol_pool: sol,
        poolsUpdatedAt: Timestamp.now(),
      }, { merge: true });
      return res.status(200).json({ success: true, usdt_pool: usdt, ltc_pool: ltc, sol_pool: sol });
    } catch (e) {
      console.error('Set-pools error:', e.message || e);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }

  if (action === 'set_base_rates') {
    const usdt = parseFloat(baseUsdtRate);
    const ltc  = parseFloat(baseLtcRate);
    const sol  = parseFloat(baseSolRate);
    if (!isFinite(usdt) || usdt < 0 || !isFinite(ltc) || ltc < 0 || !isFinite(sol) || sol < 0) {
      return res.status(400).json({ success: false, error: 'Base rates must be non-negative numbers.' });
    }
    try {
      await db.collection('stats').doc('global').set({
        base_usdt_rate: usdt,
        base_ltc_rate: ltc,
        base_sol_rate: sol,
        baseRatesUpdatedAt: Timestamp.now(),
      }, { merge: true });
      return res.status(200).json({ success: true, base_usdt_rate: usdt, base_ltc_rate: ltc, base_sol_rate: sol });
    } catch (e) {
      console.error('Set-base-rates error:', e.message || e);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }

  if (action === 'set_swap_fee') {
    const fee = parseFloat(swapFeePct);
    if (!isFinite(fee) || fee < 0 || fee > 100) {
      return res.status(400).json({ success: false, error: 'Swap fee must be a number between 0 and 100.' });
    }
    try {
      await db.collection('stats').doc('global').set({
        swap_fee_pct: fee,
        swapFeeUpdatedAt: Timestamp.now(),
      }, { merge: true });
      return res.status(200).json({ success: true, swap_fee_pct: fee });
    } catch (e) {
      console.error('Set-swap-fee error:', e.message || e);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }

  if (action === 'set_claim_rewards') {
    const g = parseFloat(rewardGuest);
    const l = parseFloat(rewardLogged);
    const gc = parseFloat(gameCoinsReward);
    const boost = parseFloat(claimBoostAmount);
    if (!isFinite(g) || g < 0 || !isFinite(l) || l < 0 || !isFinite(gc) || gc < 0 || !isFinite(boost) || boost < 0) {
      return res.status(400).json({ success: false, error: 'All reward values must be non-negative numbers.' });
    }
    try {
      await db.collection('stats').doc('global').set({
        usdt_reward_guest: g,
        usdt_reward_logged: l,
        game_coins_reward: gc,
        claim_boost_amount: boost,
        rewardsUpdatedAt: Timestamp.now(),
      }, { merge: true });
      return res.status(200).json({ success: true, usdt_reward_guest: g, usdt_reward_logged: l, game_coins_reward: gc, claim_boost_amount: boost });
    } catch (e) {
      console.error('Set-claim-rewards error:', e.message || e);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }

  if (action === 'set_claim_pool') {
    function parsePoolVal(val) {
      if (val === null || val === undefined || val === '') return null; // blank = disable pool
      const n = parseFloat(val);
      if (!isFinite(n) || n < 0) return undefined;
      return n;
    }
    const pool = parsePoolVal(claimPoolUsdt);
    if (pool === undefined) {
      return res.status(400).json({ success: false, error: 'Pool budget must be a non-negative number, or blank to disable.' });
    }
    const decay = parseFloat(claimPoolDecayPct);
    if (!isFinite(decay) || decay <= 0 || decay > 100) {
      return res.status(400).json({ success: false, error: 'Decay % must be a number between 0 and 100 (exclusive of 0).' });
    }
    const MAX_POOL_REWARD_CEILING = 7;
    const startReward = parseFloat(claimPoolStartReward);
    if (!isFinite(startReward) || startReward <= 0 || startReward > MAX_POOL_REWARD_CEILING) {
      return res.status(400).json({ success: false, error: `Starting reward must be a number between 0 and ${MAX_POOL_REWARD_CEILING} (exclusive of 0).` });
    }
    try {
      // Enabling or changing the settings resets remaining budget AND the
      // current per-claim reward (back to the new starting value), and
      // marks it as "today" — so the new settings apply from the very
      // next claim instead of continuing a stale decay curve from before.
      await db.collection('stats').doc('global').set({
        claim_pool_usdt: pool,
        claim_pool_decay_pct: decay,
        claim_pool_start_reward: startReward,
        claim_pool_remaining: pool,
        claim_pool_current_reward: pool != null ? Math.min(pool, startReward, MAX_POOL_REWARD_CEILING) : null,
        claim_pool_day: new Date().toISOString().slice(0, 10),
        claimPoolUpdatedAt: Timestamp.now(),
      }, { merge: true });
      return res.status(200).json({ success: true, claim_pool_usdt: pool, claim_pool_decay_pct: decay, claim_pool_start_reward: startReward });
    } catch (e) {
      console.error('Set-claim-pool error:', e.message || e);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }

  if (action === 'set_daily_link') {
    const url = (dailyLinkUrl || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ success: false, error: 'Must be a valid http(s) URL.' });
    }
    try {
      await db.collection('stats').doc('global').set({
        daily_link_url: url,
        dailyLinkUpdatedAt: Timestamp.now(),
      }, { merge: true });
      return res.status(200).json({ success: true, daily_link_url: url });
    } catch (e) {
      console.error('Set-daily-link error:', e.message || e);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }

  if (action === 'set_withdraw_limits') {
    function parseLimit(val) {
      const n = parseFloat(val);
      return (isFinite(n) && n >= 0) ? n : undefined;
    }
    const pMinUsdt = parseLimit(minUsdt);
    const pMaxUsdt = parseLimit(maxUsdt);
    const pMinLtc  = parseLimit(minLtc);
    const pMaxLtc  = parseLimit(maxLtc);
    const pMinSol  = parseLimit(minSol);
    const pMaxSol  = parseLimit(maxSol);
    if ([pMinUsdt, pMaxUsdt, pMinLtc, pMaxLtc, pMinSol, pMaxSol].some(v => v === undefined)) {
      return res.status(400).json({ success: false, error: 'All values must be non-negative numbers.' });
    }
    if (pMinUsdt > pMaxUsdt || pMinLtc > pMaxLtc || pMinSol > pMaxSol) {
      return res.status(400).json({ success: false, error: 'Min cannot be greater than max (daily limit).' });
    }
    try {
      await db.collection('stats').doc('global').set({
        withdraw_min_usdt: pMinUsdt,
        withdraw_max_usdt: pMaxUsdt,
        withdraw_min_ltc: pMinLtc,
        withdraw_max_ltc: pMaxLtc,
        withdraw_min_sol: pMinSol,
        withdraw_max_sol: pMaxSol,
        withdrawLimitsUpdatedAt: Timestamp.now(),
      }, { merge: true });
      return res.status(200).json({ success: true });
    } catch (e) {
      console.error('Set-withdraw-limits error:', e.message || e);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }

  if (action === 'set_store_config') {
    function num(val, allowZero) {
      const n = parseFloat(val);
      return (isFinite(n) && (allowZero ? n >= 0 : n > 0)) ? n : undefined;
    }
    const cfg = {
      nano_price: num(storeConfig?.nanoPrice),
      nano_power: num(storeConfig?.nanoPower),
      nano_max:   num(storeConfig?.nanoMax),
      box_price:  num(storeConfig?.boxPrice),
      mega_power: num(storeConfig?.megaPower),
      mega_max:   num(storeConfig?.megaMax),
      box_odds_tier1_chance: num(storeConfig?.tier1Chance, true),
      box_odds_tier1_amount: num(storeConfig?.tier1Amount, true),
      box_odds_tier2_chance: num(storeConfig?.tier2Chance, true),
      box_odds_tier2_amount: num(storeConfig?.tier2Amount, true),
      box_odds_tier3_chance: num(storeConfig?.tier3Chance, true),
      box_odds_tier3_amount: num(storeConfig?.tier3Amount, true),
    };
    if (Object.values(cfg).some(v => v === undefined)) {
      return res.status(400).json({ success: false, error: 'All store config fields must be valid non-negative numbers.' });
    }
    const oddsSum = cfg.box_odds_tier1_chance + cfg.box_odds_tier2_chance + cfg.box_odds_tier3_chance;
    if (oddsSum > 100) {
      return res.status(400).json({ success: false, error: `Tier 1+2+3 chances add up to ${oddsSum}% — must be ≤100% (remainder becomes MegaMiner chance).` });
    }
    try {
      await db.collection('stats').doc('global').set(cfg, { merge: true });
      return res.status(200).json({ success: true });
    } catch (e) {
      console.error('Set-store-config error:', e.message || e);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }

  if (action === 'migrate_fix_task_bonus') {
    const OLD_NANO_POWER = 0.1;
    const OLD_MEGA_POWER = 0.2;
    try {
      const usersSnap = await db.collection('users').get();
      let fixedCount = 0;
      const batch = db.batch();
      usersSnap.forEach(docSnap => {
        const d = docSnap.data();
        const ownedNano = d.miner_nano || 0;
        const ownedMega = d.miner_mega || 0;
        const bakedMinerPower = ownedNano * OLD_NANO_POWER + ownedMega * OLD_MEGA_POWER;
        if (bakedMinerPower <= 0) return;
        const current = d.task_bonus_hashrate || 0;
        const fixed = Math.max(0, Math.round((current - bakedMinerPower) * 100) / 100);
        if (fixed !== current) {
          batch.update(docSnap.ref, { task_bonus_hashrate: fixed });
          fixedCount++;
        }
      });
      await batch.commit();
      return res.status(200).json({ success: true, fixedCount, totalUsers: usersSnap.size });
    } catch (e) {
      console.error('Migrate-fix-task-bonus error:', e.message || e);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }

  if (!reqId) {
    return res.status(400).json({ success: false, error: 'Missing reqId' });
  }

  const reqRef = db.collection('ad_requests').doc(reqId);

  try {
    if (action === 'approve') {
      const numViews = parseInt(views) || 1;
      if (!bannerUrl || !clickUrl) {
        return res.status(400).json({ success: false, error: 'Missing bannerUrl/clickUrl' });
      }

      const slotRef = db.collection('ad_slots').doc();
      await db.runTransaction(async (tx) => {
        tx.update(reqRef, { status: 'active' });
        tx.set(slotRef, {
          banner_url: bannerUrl,
          click_url: clickUrl,
          status: 'active',
          views_total: numViews,
          views_shown: 0,
          req_id: reqId,
          createdAt: Timestamp.now(),
        });
      });
      return res.status(200).json({ success: true });
    }

    if (action === 'reject') {
      await reqRef.update({ status: 'rejected' });
      return res.status(200).json({ success: true });
    }

    if (action === 'revoke') {
      const slotsSnap = await db.collection('ad_slots').where('req_id', '==', reqId).get();
      const batch = db.batch();
      slotsSnap.forEach(doc => batch.delete(doc.ref));
      batch.update(reqRef, { status: 'pending' });
      await batch.commit();
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ success: false, error: 'Unknown action' });

  } catch (e) {
    console.error('Moderate-ad error:', e.message || e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}
