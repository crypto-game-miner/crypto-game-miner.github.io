// api/deposit-webhook.js

import crypto from 'crypto';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const APP_ID     = process.env.CCPAYMENT_APP_ID;
const APP_SECRET = process.env.CCPAYMENT_APP_SECRET;

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

function verifySignature(bodyStr, timestamp, receivedSign) {
  const raw      = APP_ID + APP_SECRET + timestamp + bodyStr;
  const expected = crypto.createHash('sha256').update(raw).digest('hex');
  return expected === receivedSign;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const timestamp    = req.headers['timestamp'] || '';
  const receivedSign = req.headers['sign']      || '';

  const payload  = req.body || {};
  const bodyStr  = JSON.stringify(payload);

  if (!verifySignature(bodyStr, timestamp, receivedSign)) {
    console.error('Invalid signature');
  }

  // Реальная структура вебхука: { type: "DirectDeposit", msg: { ... } }
  const msg = payload.msg || payload;

  if (msg.status !== 'Success') {
    return res.status(200).json({ msg: 'Success' });
  }

  const userId     = msg.referenceId;
  const coinSymbol = msg.coinSymbol;
  const amount     = parseFloat(msg.amount || msg.value || '0');

  if (!userId || !coinSymbol || amount <= 0) {
    console.log('Missing data:', { userId, coinSymbol, amount });
    return res.status(200).json({ msg: 'Success' });
  }

  try {
    const db      = initFirebase();
    const userRef = db.collection('users').doc(userId);
    const depKey  = `dep_${Date.now()}`;

    if (coinSymbol === 'USDT') {
      const usdtCoins = Math.floor(amount * 1_000_000);
      await userRef.update({
        coins: FieldValue.increment(usdtCoins),
        [`deposits.${depKey}`]: { type: 'USDT', amount, coins_added: usdtCoins, at: new Date() },
      });
      console.log(`+${usdtCoins} USDT Coins → ${userId}`);

    } else if (coinSymbol === 'LTC') {
      const ltcCoins = Math.floor(amount * 100_000_000);
      await userRef.update({
        ltc: FieldValue.increment(ltcCoins),
        [`deposits.${depKey}`]: { type: 'LTC', amount, ltc_coins_added: ltcCoins, at: new Date() },
      });
      console.log(`+${ltcCoins} LTC Coins → ${userId}`);
    }

  } catch (e) {
    console.error('Firebase error:', e.message);
  }

  return res.status(200).json({ msg: 'Success' });
}

