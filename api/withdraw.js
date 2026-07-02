// api/withdraw.js (SECURE VERSION)
// Verifies the user actually has enough balance in Firestore BEFORE
// sending real crypto via FaucetPay. Deducts balance atomically.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const MIN_USDT = 200;
const MIN_LTC  = 400;
const DAILY_LIMIT_USDT = 700;
const DAILY_LIMIT_LTC  = 1500;

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

  const minCoins = currency === 'usdt' ? MIN_USDT : MIN_LTC;
  if (points < minCoins) {
    return res.status(400).json({ status: 400, message: `Minimum ${minCoins} ${currency.toUpperCase()} Coins` });
  }
  if (!email.includes('@')) {
    return res.status(400).json({ status: 400, message: 'Invalid email' });
  }

  const db = initFirebase();
  const userRef = db.collection('users').doc(uid);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw { code: 'NO_USER', message: 'User not found' };

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

      const dailyLimit = currency === 'usdt' ? DAILY_LIMIT_USDT : DAILY_LIMIT_LTC;
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
    const status = code === 'INSUFFICIENT' || code === 'DAILY_LIMIT' ? 400 : 500;
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



