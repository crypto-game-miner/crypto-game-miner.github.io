// api/withdraw.js (SECURE VERSION)
// Handles two actions on the same endpoint (merged to stay under Vercel's
// serverless function count limit, same pattern as api/claim.js):
//   - no action / action==='withdraw' (default): sends real crypto via FaucetPay
//   - action: 'swap': converts USDT Coins <-> LTC Coins at their real-dollar
//     value, minus an admin-adjustable fee (stats/global.swap_fee_pct)

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// Fallback defaults — used only if stats/global doesn't have a value set yet.
const DEFAULT_MIN_USDT = 200;
const DEFAULT_MIN_LTC  = 400;
const DEFAULT_DAILY_LIMIT_USDT = 700;
const DEFAULT_DAILY_LIMIT_LTC  = 1500;

const USDT_COIN_TO_REAL_USD = 0.000001;
const LTC_COIN_TO_LTC = 0.00000001;
const DEFAULT_SWAP_FEE_PCT = 5;

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

async function fetchLtcPriceUsd() {
  const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd');
  const data = await resp.json();
  const price = data?.litecoin?.usd;
  if (!price || !isFinite(price)) throw new Error('Could not fetch LTC price');
  return price;
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
// WITHDRAW — original flow, unchanged
// ─────────────────────────────────────────────────────────────────
async function handleWithdraw(req, res, body) {
  const uid      = body.uid;
  const email    = body.email;
  const points   = Number(body.points);
  const currency = (body.currency || 'usdt').toLowerCase();

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
      // Firestore transactions require ALL reads before ANY writes.
      const [snap, statsSnap] = await Promise.all([tx.get(userRef), tx.get(statsRef)]);
      if (!snap.exists) throw { code: 'NO_USER', message: 'User not found' };

      const g = statsSnap.exists ? statsSnap.data() : {};
      const minCoins = currency === 'usdt'
        ? (g.withdraw_min_usdt != null ? g.withdraw_min_usdt : DEFAULT_MIN_USDT)
        : (g.withdraw_min_ltc  != null ? g.withdraw_min_ltc  : DEFAULT_MIN_LTC);
      const dailyLimit = currency === 'usdt'
        ? (g.withdraw_max_usdt != null ? g.withdraw_max_usdt : DEFAULT_DAILY_LIMIT_USDT)
        : (g.withdraw_max_ltc  != null ? g.withdraw_max_ltc  : DEFAULT_DAILY_LIMIT_LTC);

      if (points < minCoins) {
        throw { code: 'BELOW_MIN', message: `Minimum ${minCoins} ${currency.toUpperCase()} Coins` };
      }

      const data = snap.data();
      const balanceField = currency === 'usdt' ? 'coins' : 'ltc';
      const currentBalance = data[balanceField] || 0;

      if (points > currentBalance) {
        throw { code: 'INSUFFICIENT', message: `Not enough ${currency.toUpperCase()} Coins. You have ${currentBalance}.` };
      }

      const today = new Date().toDateString();
      const withdrawDayField = currency === 'usdt' ? 'withdrawDayUsdt' : 'withdrawDayLtc';
      const withdrawnField   = currency === 'usdt' ? 'withdrawnTodayUsdt' : 'withdrawnTodayLtc';
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
  const currency2 = (body.currency || 'usdt').toLowerCase();
  const points2 = Number(body.points);
  if (currency2 === 'usdt') {
    amount = Math.round(points2 * 100);
    fpCurrency = 'USDT';
  } else {
    amount = Math.round(points2);
    fpCurrency = 'LTC';
  }

  const db2 = initFirebase();
  const userRef2 = db2.collection('users').doc(body.uid);

  try {
    const fpResponse = await fetch('https://faucetpay.io/api/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        api_key:  process.env.FAUCETPAY_API_KEY,
        currency: fpCurrency,
        amount:   amount,
        to:       body.email,
        referral: 'no',
      }),
    });

    const text = await fpResponse.text();
    let data;
    try { data = JSON.parse(text); }
    catch {
      await refundUser(db2, userRef2, currency2, points2);
      return res.status(502).json({ status: 502, message: 'FaucetPay error (refunded): ' + text });
    }

    if (data.status !== 200) {
      await refundUser(db2, userRef2, currency2, points2);
      return res.status(200).json(data);
    }

    return res.status(200).json(data);

  } catch (e) {
    console.error('FaucetPay request error:', e.message);
    await refundUser(db2, userRef2, currency2, points2);
    return res.status(500).json({ status: 500, message: 'Server error (refunded): ' + e.message });
  }
}

async function refundUser(db, userRef, currency, points) {
  const balanceField = currency === 'usdt' ? 'coins' : 'ltc';
  try {
    await userRef.update({ [balanceField]: FieldValue.increment(points) });
  } catch (e) {
    console.error('CRITICAL: refund failed for', userRef.id, e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// SWAP — converts USDT Coins <-> LTC Coins at real-dollar value,
// minus an admin-adjustable fee. Uses the same real-dollar constants
// used throughout admin-stats.html for consistency.
// ─────────────────────────────────────────────────────────────────
async function handleSwap(req, res, body) {
  const { uid, direction, amount } = body;
  if (!uid) return res.status(400).json({ success: false, error: 'Missing uid' });
  if (direction !== 'usdt_to_ltc' && direction !== 'ltc_to_usdt') {
    return res.status(400).json({ success: false, error: 'Invalid direction' });
  }
  const amountIn = Number(amount);
  if (!amountIn || !isFinite(amountIn) || amountIn <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid amount' });
  }

  const db = initFirebase();
  const userRef  = db.collection('users').doc(uid);
  const statsRef = db.collection('stats').doc('global');

  // Fetched once outside the transaction — CoinGecko isn't part of
  // Firestore, so it can't be read inside a transaction anyway.
  let ltcPriceUsd;
  try {
    ltcPriceUsd = await fetchLtcPriceUsd();
  } catch (e) {
    return res.status(502).json({ success: false, error: 'Could not fetch live LTC price. Try again shortly.' });
  }

  try {
    const result = await db.runTransaction(async (tx) => {
      const [snap, statsSnap] = await Promise.all([tx.get(userRef), tx.get(statsRef)]);
      if (!snap.exists) throw { code: 'NO_USER', message: 'User not found.' };

      const d = snap.data();
      const g = statsSnap.exists ? statsSnap.data() : {};
      const feePct = g.swap_fee_pct != null ? g.swap_fee_pct : DEFAULT_SWAP_FEE_PCT;

      let sourceField, destField, sourceBalance, amountOut;

      if (direction === 'usdt_to_ltc') {
        sourceField = 'coins'; destField = 'ltc';
        sourceBalance = d.coins || 0;
        if (amountIn > sourceBalance) {
          throw { code: 'INSUFFICIENT', message: `Not enough USDT Coins. You have ${sourceBalance.toFixed(4)}.` };
        }
        const usdValue = amountIn * USDT_COIN_TO_REAL_USD;
        const usdValueAfterFee = usdValue * (1 - feePct / 100);
        amountOut = (usdValueAfterFee / ltcPriceUsd) / LTC_COIN_TO_LTC;
      } else {
        sourceField = 'ltc'; destField = 'coins';
        sourceBalance = d.ltc || 0;
        if (amountIn > sourceBalance) {
          throw { code: 'INSUFFICIENT', message: `Not enough LTC Coins. You have ${sourceBalance.toFixed(4)}.` };
        }
        const usdValue = amountIn * LTC_COIN_TO_LTC * ltcPriceUsd;
        const usdValueAfterFee = usdValue * (1 - feePct / 100);
        amountOut = usdValueAfterFee / USDT_COIN_TO_REAL_USD;
      }

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
        amountIn,
        amountOut,
        feePct,
        ltcPriceUsd,
        newCoins: direction === 'usdt_to_ltc' ? newSource : newDest,
        newLtc:   direction === 'usdt_to_ltc' ? newDest   : newSource,
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


