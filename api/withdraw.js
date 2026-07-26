// api/withdraw.js (SECURE VERSION)
// Handles two actions on the same endpoint (merged to stay under Vercel's
// serverless function count limit, same pattern as api/claim.js):
//   - no action / action==='withdraw' (default): sends real crypto via FaucetPay
//   - action: 'swap': converts between any two of USDT/LTC/SOL Coins based
//     on their real-dollar value, minus an admin-adjustable fee
//     (stats/global.swap_fee_pct)
//
// Currencies supported for withdraw: usdt, ltc, sol.
// Coin-to-real-unit ratios follow a consistent "Bitcoin-satoshi-style"
// 8-decimal pattern across LTC and SOL (NOT each coin's native on-chain
// decimal count): 1 LTC Coin = 0.00000001 LTC (litoshi, matches LTC's real
// 8 decimals), 1 SOL Coin = 0.00000001 SOL (does NOT match SOL's real
// 9-decimal lamport — this is intentional per product decision, not a bug).
// Since FaucetPay's "amount" field is assumed to expect real lamports
// (SOL's actual on-chain smallest unit, 1e-9 SOL), 1 SOL Coin = 10 real
// lamports, so amount sent to FaucetPay = points * 10. UNVERIFIED — test
// with a small real withdrawal to your own FaucetPay account first.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// Fallback defaults — used only if stats/global doesn't have a value set yet.
const DEFAULT_MIN_USDT = 200;
const DEFAULT_MIN_LTC  = 400;
const DEFAULT_MIN_SOL  = 1000000;
const DEFAULT_DAILY_LIMIT_USDT = 700;
const DEFAULT_DAILY_LIMIT_LTC  = 1500;
const DEFAULT_DAILY_LIMIT_SOL  = 5000000;

const USDT_COIN_TO_REAL_USD = 0.000001;
const LTC_COIN_TO_LTC = 0.00000001;
const SOL_COIN_TO_SOL = 0.00000001; // Bitcoin-satoshi-style 8 decimals, not native lamport (9 decimals)
const DEFAULT_SWAP_FEE_PCT = 5;

const BALANCE_FIELD = { usdt: 'coins', ltc: 'ltc', sol: 'sol' };

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

// Fetches both LTC and SOL prices in one call — needed regardless of which
// pair is being swapped, since either leg might be ltc or sol.
async function fetchPricesUsd() {
  const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=litecoin,solana&vs_currencies=usd');
  const data = await resp.json();
  const ltc = data?.litecoin?.usd;
  const sol = data?.solana?.usd;
  if (!ltc || !isFinite(ltc) || !sol || !isFinite(sol)) throw new Error('Could not fetch live prices');
  return { ltc, sol };
}

function coinUsdValue(coin, amount, prices) {
  if (coin === 'usdt') return amount * USDT_COIN_TO_REAL_USD;
  if (coin === 'ltc')  return amount * LTC_COIN_TO_LTC * prices.ltc;
  return amount * SOL_COIN_TO_SOL * prices.sol; // sol
}

function usdValuePerUnit(coin, prices) {
  if (coin === 'usdt') return USDT_COIN_TO_REAL_USD;
  if (coin === 'ltc')  return LTC_COIN_TO_LTC * prices.ltc;
  return SOL_COIN_TO_SOL * prices.sol; // sol
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ status: 405, message: 'Method not allowed' });

  const body = req.body || {};

  if (body.action === 'swap') {
    return handleSwap(req, res, body);
  }
  return handleWithdraw(req, res, body);
}

// ─────────────────────────────────────────────────────────────────
// WITHDRAW — usdt, ltc, sol
// ─────────────────────────────────────────────────────────────────
async function handleWithdraw(req, res, body) {
  const uid      = body.uid;
  const email    = body.email;
  const points   = Number(body.points);
  const currency = (body.currency || 'usdt').toLowerCase();

  if (!['usdt', 'ltc', 'sol'].includes(currency)) {
    return res.status(400).json({ status: 400, message: 'Invalid currency' });
  }
  if (!uid || !email || !points || isNaN(points)) {
    return res.status(400).json({ status: 400, message: 'Missing uid, email or points' });
  }
  if (!email.includes('@')) {
    return res.status(400).json({ status: 400, message: 'Invalid email' });
  }

  const db = initFirebase();
  const userRef  = db.collection('users').doc(uid);
  const statsRef = db.collection('stats').doc('global');

  try {
    await db.runTransaction(async (tx) => {
      const [snap, statsSnap] = await Promise.all([tx.get(userRef), tx.get(statsRef)]);
      if (!snap.exists) throw { code: 'NO_USER', message: 'User not found' };

      const g = statsSnap.exists ? statsSnap.data() : {};

      let minCoins, dailyLimit;
      if (currency === 'usdt') {
        minCoins   = g.withdraw_min_usdt != null ? g.withdraw_min_usdt : DEFAULT_MIN_USDT;
        dailyLimit = g.withdraw_max_usdt != null ? g.withdraw_max_usdt : DEFAULT_DAILY_LIMIT_USDT;
      } else if (currency === 'ltc') {
        minCoins   = g.withdraw_min_ltc != null ? g.withdraw_min_ltc : DEFAULT_MIN_LTC;
        dailyLimit = g.withdraw_max_ltc != null ? g.withdraw_max_ltc : DEFAULT_DAILY_LIMIT_LTC;
      } else {
        minCoins   = g.withdraw_min_sol != null ? g.withdraw_min_sol : DEFAULT_MIN_SOL;
        dailyLimit = g.withdraw_max_sol != null ? g.withdraw_max_sol : DEFAULT_DAILY_LIMIT_SOL;
      }

      if (points < minCoins) {
        throw { code: 'BELOW_MIN', message: `Minimum ${minCoins} ${currency.toUpperCase()} Coins` };
      }

      const data = snap.data();
      const balanceField = BALANCE_FIELD[currency];
      const currentBalance = data[balanceField] || 0;

      if (points > currentBalance) {
        throw { code: 'INSUFFICIENT', message: `Not enough ${currency.toUpperCase()} Coins. You have ${currentBalance}.` };
      }

      const today = new Date().toDateString();
      const withdrawDayField = currency === 'usdt' ? 'withdrawDayUsdt' : currency === 'ltc' ? 'withdrawDayLtc' : 'withdrawDaySol';
      const withdrawnField   = currency === 'usdt' ? 'withdrawnTodayUsdt' : currency === 'ltc' ? 'withdrawnTodayLtc' : 'withdrawnTodaySol';
      let withdrawnToday = data[withdrawnField] || 0;
      if (data[withdrawDayField] !== today) withdrawnToday = 0;

      if (withdrawnToday + points > dailyLimit) {
        throw { code: 'DAILY_LIMIT', message: `Daily limit is ${dailyLimit} ${currency.toUpperCase()} Coins. You can withdraw ${dailyLimit - withdrawnToday} more today.` };
      }

      tx.update(userRef, {
        [balanceField]: FieldValue.increment(-points),
        [withdrawDayField]: today,
        [withdrawnField]: withdrawnToday + points,
      });
    });
  } catch (e) {
    const code = e.code || 'ERROR';
    const msg  = e.message || 'Transaction failed';
    const status = ['INSUFFICIENT', 'DAILY_LIMIT', 'BELOW_MIN'].includes(code) ? 400 : 500;
    return res.status(status).json({ status, message: msg, code });
  }

  let amount, fpCurrency;
  if (currency === 'usdt') {
    amount = Math.round(points * 100);
    fpCurrency = 'USDT';
  } else if (currency === 'ltc') {
    amount = Math.round(points);
    fpCurrency = 'LTC';
  } else {
    // SOL: 1 SOL Coin = 0.00000001 SOL = 10 real lamports (SOL's actual
    // on-chain unit is 1e-9 SOL). UNVERIFIED against FaucetPay's actual
    // expected amount granularity — test with a small real withdrawal
    // before relying on this.
    amount = Math.round(points * 10);
    fpCurrency = 'SOL';
  }

  const db2 = initFirebase();
  const userRef2 = db2.collection('users').doc(uid);
  const balanceField2 = BALANCE_FIELD[currency];

  try {
    const fpResponse = await fetch('https://faucetpay.io/api/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        api_key:  process.env.FAUCETPAY_API_KEY,
        currency: fpCurrency,
        amount:   amount,
        to:       email,
        referral: 'no',
      }),
    });

    const text = await fpResponse.text();
    let data;
    try { data = JSON.parse(text); }
    catch {
      await refundUser(db2, userRef2, balanceField2, points);
      return res.status(502).json({ status: 502, message: 'FaucetPay error (refunded): ' + text });
    }

    if (data.status !== 200) {
      await refundUser(db2, userRef2, balanceField2, points);
      return res.status(200).json(data);
    }

    return res.status(200).json(data);

  } catch (e) {
    console.error('FaucetPay request error:', e.message);
    await refundUser(db2, userRef2, balanceField2, points);
    return res.status(500).json({ status: 500, message: 'Server error (refunded): ' + e.message });
  }
}

async function refundUser(db, userRef, balanceField, points) {
  try {
    await userRef.update({ [balanceField]: FieldValue.increment(points) });
  } catch (e) {
    console.error('CRITICAL: refund failed for', userRef.id, e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// SWAP — converts between any two of usdt/ltc/sol at real-dollar value,
// minus an admin-adjustable fee.
// ─────────────────────────────────────────────────────────────────
async function handleSwap(req, res, body) {
  const { uid, fromCoin, toCoin, amount } = body;
  if (!uid) return res.status(400).json({ success: false, error: 'Missing uid' });
  if (!['usdt', 'ltc', 'sol'].includes(fromCoin) || !['usdt', 'ltc', 'sol'].includes(toCoin)) {
    return res.status(400).json({ success: false, error: 'Invalid coin' });
  }
  if (fromCoin === toCoin) {
    return res.status(400).json({ success: false, error: 'Cannot swap a coin for itself' });
  }
  const amountIn = Number(amount);
  if (!amountIn || !isFinite(amountIn) || amountIn <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid amount' });
  }

  const db = initFirebase();
  const userRef  = db.collection('users').doc(uid);
  const statsRef = db.collection('stats').doc('global');

  let prices;
  try {
    prices = await fetchPricesUsd();
  } catch (e) {
    return res.status(502).json({ success: false, error: 'Could not fetch live prices. Try again shortly.' });
  }

  try {
    const result = await db.runTransaction(async (tx) => {
      const [snap, statsSnap] = await Promise.all([tx.get(userRef), tx.get(statsRef)]);
      if (!snap.exists) throw { code: 'NO_USER', message: 'User not found.' };

      const d = snap.data();
      const g = statsSnap.exists ? statsSnap.data() : {};
      const feePct = g.swap_fee_pct != null ? g.swap_fee_pct : DEFAULT_SWAP_FEE_PCT;

      const sourceField = BALANCE_FIELD[fromCoin];
      const destField   = BALANCE_FIELD[toCoin];
      const sourceBalance = d[sourceField] || 0;

      if (amountIn > sourceBalance) {
        throw { code: 'INSUFFICIENT', message: `Not enough ${fromCoin.toUpperCase()} Coins. You have ${sourceBalance.toFixed(4)}.` };
      }

      const usdValue = coinUsdValue(fromCoin, amountIn, prices);
      const usdValueAfterFee = usdValue * (1 - feePct / 100);
      const amountOut = usdValueAfterFee / usdValuePerUnit(toCoin, prices);

      if (!isFinite(amountOut) || amountOut <= 0) {
        throw { code: 'TOO_SMALL', message: 'Amount too small to swap after fee.' };
      }

      const newSource = sourceBalance - amountIn;
      const newDest = (d[destField] || 0) + amountOut;

      tx.set(userRef, {
        [sourceField]: newSource,
        [destField]: newDest,
      }, { merge: true });

      return {
        fromCoin, toCoin,
        amountIn, amountOut, feePct,
        prices,
      };
    });

    return res.status(200).json({ success: true, ...result });

  } catch (e) {
    const code = e.code || 'ERROR';
    const msg  = e.message || 'Swap failed';
    const status = ['INSUFFICIENT', 'TOO_SMALL'].includes(code) ? 400 : 500;
    if (status === 500) console.error('Swap error:', msg);
    return res.status(status).json({ success: false, error: msg, code });
  }
}


