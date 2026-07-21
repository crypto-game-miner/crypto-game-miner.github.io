// api/withdraw.js (SECURE VERSION)
// Verifies the user actually has enough balance in Firestore BEFORE
// sending real crypto via FaucetPay. Deducts balance atomically.
// Min/max withdraw limits are admin-adjustable via api/moderate-ad.js
// (action: set_withdraw_limits), stored in stats/global — read here
// inside the same transaction so the server always enforces whatever
// the admin panel currently shows, not stale hardcoded defaults.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// Fallback defaults — used only if stats/global doesn't have a value set yet.
const DEFAULT_MIN_USDT = 200;
const DEFAULT_MIN_LTC  = 400;
const DEFAULT_DAILY_LIMIT_USDT = 700;
const DEFAULT_DAILY_LIMIT_LTC  = 1500;

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
  if (req.method !== 'POST') return res.status(405).json({ status: 405, message: 'Method not allowed' });

  const body     = req.body || {};
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
  if (currency === 'usdt') {
    amount = Math.round(points * 100);
    fpCurrency = 'USDT';
  } else {
    amount = Math.round(points);
    fpCurrency = 'LTC';
  }

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
      await refundUser(db, userRef, currency, points);
      return res.status(502).json({ status: 502, message: 'FaucetPay error (refunded): ' + text });
    }

    if (data.status !== 200) {
      await refundUser(db, userRef, currency, points);
      return res.status(200).json(data);
    }

    return res.status(200).json(data);

  } catch (e) {
    console.error('FaucetPay request error:', e.message);
    await refundUser(db, userRef, currency, points);
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


