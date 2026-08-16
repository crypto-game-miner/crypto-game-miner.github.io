import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

// Fallback defaults — used only if the admin hasn't set base_usdt_rate /
// base_ltc_rate / base_sol_rate in Firestore yet.
const DEFAULT_LTC_RATE  = 2.5;
const DEFAULT_USDT_RATE = 1.1;
const DEFAULT_SOL_RATE  = 1.5;
const MAX_SECONDS = 86400;
const EXP_PER_LEVEL = [50, 120, 250, 500, 1000];
const CLAIM_STREAK_CAP_DAYS = 30; // +1%/day mining power bonus, capped at +30% — mirrors claim.js / home.html

// Minimum time between full leaderboard_public scans (refreshGlobalStats).
// Was running on every single sync call (every ~60s per open tab), reading
// the entire leaderboard_public collection each time — this is what blew
// through the Firestore Spark plan's free daily read quota. Now it only
// runs once this interval has elapsed, triggered by whichever sync call
// happens to land first after that.
const STATS_REFRESH_INTERVAL_MS = 3600000; // 1 hour

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

// Public display name that never leaks the real email — just the part
// before '@', or a stable Guest_XXXX tag derived from the uid.
function publicDisplayName(data, uid) {
  if (data.email && typeof data.email === 'string' && data.email.includes('@')) {
    return data.email.split('@')[0];
  }
  return 'Guest_' + uid.slice(-4).toUpperCase();
}

// Effective rate = pool spread across active hashrate, but NEVER above the
// base rate — a thin pool with few active miners would otherwise pay out
// more per GH/S/hr than intended. The pool can only ever reduce payout
// below base, never increase it above base.
function effectiveRate(pool, activeHashrate, baseRate) {
  if (pool == null || activeHashrate <= 0) return baseRate;
  const poolRate = pool / (24 * activeHashrate);
  return Math.min(poolRate, baseRate);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { uid, miningCoin } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'Missing uid' });
  const coin = miningCoin === 'usdt' ? 'usdt' : miningCoin === 'sol' ? 'sol' : 'ltc';

  const db = initFirebase();
  const userRef = db.collection('users').doc(uid);
  const leaderboardRef = db.collection('leaderboard_public').doc(uid);

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw { code: 'NO_USER' };

      // Admin-adjustable daily pools AND base rates — read here (before
      // any writes, Firestore transactions require all reads first). The
      // effective rate is capped at the base rate (see effectiveRate above)
      // — the pool can only reduce payout below base, never raise it above.
      const statsGlobalRef = db.collection('stats').doc('global');
      const statsGlobalSnap = await tx.get(statsGlobalRef);
      const g = statsGlobalSnap.exists ? statsGlobalSnap.data() : {};
      const usdtPool = g.usdt_pool != null ? g.usdt_pool : null;
      const ltcPool  = g.ltc_pool  != null ? g.ltc_pool  : null;
      const solPool  = g.sol_pool  != null ? g.sol_pool  : null;
      const activeHashrateUsdt = g.activeHashrateUsdt || 0;
      const activeHashrateLtc  = g.activeHashrateLtc  || 0;
      const activeHashrateSol  = g.activeHashrateSol  || 0;
      const baseUsdtRate = g.base_usdt_rate != null ? g.base_usdt_rate : DEFAULT_USDT_RATE;
      const baseLtcRate  = g.base_ltc_rate  != null ? g.base_ltc_rate  : DEFAULT_LTC_RATE;
      const baseSolRate  = g.base_sol_rate  != null ? g.base_sol_rate  : DEFAULT_SOL_RATE;

      // When stats/global was last recomputed by refreshGlobalStats() —
      // used after the transaction to decide whether a fresh recompute is
      // due yet (see STATS_REFRESH_INTERVAL_MS).
      const statsUpdatedMs = g.updatedAt?.toMillis ? g.updatedAt.toMillis() : 0;

      const data = snap.data();
      const now = Date.now();
      const today = new Date().toISOString().slice(0, 10);

      const lastClaimMs = data.lastClaimTime?.toMillis ? data.lastClaimTime.toMillis() : 0;
      const miningPaused = lastClaimMs === 0 || (now - lastClaimMs) / 1000 / 3600 > 24;

      const level = getLevel(data.exp || 0);
      const baseHashrate = level >= 2 ? 0.5 : 0;
      const taskBonus = data.task_bonus_hashrate || 0;
      const seasonBonus = data.season_bonus_hashrate || 0;
      // Miner power computed live from owned counts × current admin-set
      // power, same as home.html — so admin changes to nano/mega power
      // apply retroactively here too, keeping actual mining income
      // consistent with what home.html displays.
      const ownedNano = data.miner_nano || 0;
      const ownedMega = data.miner_mega || 0;
      const nanoPower = g.nano_power != null ? g.nano_power : 0.1;
      const megaPower = g.mega_power != null ? g.mega_power : 0.2;
      const minerPower = ownedNano * nanoPower + ownedMega * megaPower;
      const permHashrate = Math.round((baseHashrate + taskBonus + seasonBonus + minerPower) * 100) / 100;

      const boosts = (data.claimBoosts || []).filter(b => {
        const t = b.time?.toMillis ? b.time.toMillis() : b.time;
        return now - t < 86400000;
      });
      const boostTotal = Math.round(boosts.reduce((s, b) => s + b.amount, 0) * 100) / 100;

      // Daily claim streak bonus — +1% mining power per consecutive claim
      // day, capped at +30%. claimStreak is written by api/claim.js.
      const claimStreak = Math.min(data.claimStreak || 0, CLAIM_STREAK_CAP_DAYS);
      const streakBonusPct = claimStreak * 0.01;
      const totalHashrate = Math.round((permHashrate + boostTotal) * (1 + streakBonusPct) * 100) / 100;

      const lastSyncMs = data.lastMiningSync?.toMillis ? data.lastMiningSync.toMillis() : now;
      const secondsElapsed = Math.min(Math.max((now - lastSyncMs) / 1000, 0), MAX_SECONDS);

      const updates = { lastMiningSync: Timestamp.fromMillis(now), claimBoosts: boosts, mining_coin: coin };
      let earned = 0;
      const balanceField = coin === 'usdt' ? 'coins' : coin === 'sol' ? 'sol' : 'ltc';

      if (!miningPaused && totalHashrate > 0 && secondsElapsed > 0) {
        let rate;
        if (coin === 'usdt') {
          rate = effectiveRate(usdtPool, activeHashrateUsdt, baseUsdtRate);
        } else if (coin === 'sol') {
          rate = effectiveRate(solPool, activeHashrateSol, baseSolRate);
        } else {
          rate = effectiveRate(ltcPool, activeHashrateLtc, baseLtcRate);
        }
        earned = totalHashrate * rate / 3600 * secondsElapsed;
        updates[balanceField] = (data[balanceField] || 0) + earned;
      }

      tx.set(userRef, updates, { merge: true });

      // Daily site-wide stats — how much is being mined out today, split
      // by which coin track it came from.
      if (earned > 0) {
        const dailyStatsRef = db.collection('stats').doc('daily_' + today);
        const field = coin === 'usdt' ? 'usdt_from_mining' : coin === 'sol' ? 'sol_from_mining' : 'ltc_from_mining';
        tx.set(dailyStatsRef, {
          [field]: FieldValue.increment(earned),
          updatedAt: Timestamp.fromMillis(now),
        }, { merge: true });
      }

      // ─── Mirror safe, public-only fields for the leaderboard ────────
      // Never write email, coins, ltc, sol, or anything sensitive here —
      // this collection is publicly readable by design.
      tx.set(leaderboardRef, {
        display_name: publicDisplayName(data, uid),
        hashrate: totalHashrate,
        level,
        miner_nano: (data.miner_nano || 0) + (data.miner_mega || 0),
        // last_claim_ms lets readers compute "is active" live (claimed
        // within the last 24h) instead of trusting a stale is_active flag
        // that only updates when this user happens to sync again.
        last_claim_ms: lastClaimMs,
        mining_coin: coin,
        updatedAt: Timestamp.fromMillis(now),
      }, { merge: true });

      return {
        earned,
        coin,
        coins: coin === 'usdt' ? (data.coins || 0) + earned : (data.coins || 0),
        ltc:   coin === 'ltc'  ? (data.ltc   || 0) + earned : (data.ltc   || 0),
        sol:   coin === 'sol'  ? (data.sol   || 0) + earned : (data.sol   || 0),
        totalHashrate,
        miningPaused,
        level,
        statsUpdatedMs,
      };
    });

    // Only recompute the site-wide leaderboard stats (a full scan of
    // leaderboard_public) if it's been at least an hour since the last
    // recompute. This is what keeps Firestore reads within the free quota
    // — previously this ran on every single sync call.
    if (Date.now() - (result.statsUpdatedMs || 0) >= STATS_REFRESH_INTERVAL_MS) {
      try {
        await refreshGlobalStats(db);
      } catch (e) {
        console.error('Global stats refresh failed (sync still succeeds):', e.message || e);
      }
    }

    const { statsUpdatedMs, ...publicResult } = result;
    return res.status(200).json({ success: true, ...publicResult });
  } catch (e) {
    console.error('Sync mining error:', e.message || e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

// Recomputes stats/global (totalPlayers, totalHashrate, activeHashrate)
// from leaderboard_public — cheap since it only has the few public fields,
// not the full users collection. Runs after the main response so it never
// delays the claim/sync itself; failure here is non-fatal. Throttled to
// run at most once per STATS_REFRESH_INTERVAL_MS (see call site above).
async function refreshGlobalStats(db) {
  const snap = await db.collection('leaderboard_public').get();
  const now = Date.now();
  let totalPlayers = 0, totalHashrate = 0, activeHashrate = 0;
  let activeHashrateUsdt = 0, activeHashrateLtc = 0, activeHashrateSol = 0;

  snap.forEach(d => {
    const data = d.data();
    if (!data.hashrate || data.hashrate <= 0) return;
    totalPlayers++;
    totalHashrate += data.hashrate;

    // Computed live from last_claim_ms every time, so a player who claimed
    // >24h ago and never came back to sync again correctly drops out of
    // "active" instead of staying stuck at whatever it was last synced.
    const lastClaimMs = data.last_claim_ms || 0;
    const isActiveNow = lastClaimMs > 0 && (now - lastClaimMs) < 86400000;

    if (isActiveNow) {
      activeHashrate += data.hashrate;
      if (data.mining_coin === 'usdt') activeHashrateUsdt += data.hashrate;
      else if (data.mining_coin === 'sol') activeHashrateSol += data.hashrate;
      else activeHashrateLtc += data.hashrate; // default to ltc if unset (legacy docs)
    }
  });

  await db.collection('stats').doc('global').set({
    totalPlayers,
    totalHashrate: Math.round(totalHashrate * 100) / 100,
    activeHashrate: Math.round(activeHashrate * 100) / 100,
    activeHashrateUsdt: Math.round(activeHashrateUsdt * 100) / 100,
    activeHashrateLtc: Math.round(activeHashrateLtc * 100) / 100,
    activeHashrateSol: Math.round(activeHashrateSol * 100) / 100,
    updatedAt: Timestamp.fromMillis(Date.now()),
  }, { merge: true });
}




