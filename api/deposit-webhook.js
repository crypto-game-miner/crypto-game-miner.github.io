// api/deposit-webhook.js
// CCPayment calls this when deposit confirmed.
// USDT: 1 USDT = 1,000,000 USDT Coins
// LTC:  1 LTC  = 100,000,000 LTC Coins (1 LTC Coin = 1 satoshi)

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

function verifySignature(body, timestamp, receivedSign) {
  const raw      = APP_ID + APP_SECRET + timestamp + body;
  const expected = crypto.createHash('sha256').update(raw).digest('hex');
  return expected === receivedSign;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const timestamp    = req.headers['timestamp'] || '';
  const receivedSign = req.headers['sign']      || '';

  // Collect raw body for signature
  let rawBody = '';
  await new Promise((resolve) => {
    req.on('data', (chunk) => { rawBody += chunk; });
    req.on('end', resolve);
  });

  if (!verifySignature(rawBody, timestamp, receivedSign)) {
    console.error('CCPayment webhook: invalid signature');
    return res.status(400).send('Invalid signature');
  }

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { return res.status(400).send('Bad JSON'); }

  // status 1 = deposit success
  if (payload.status !== 1) {
    return res.status(200).send('success');
  }

  const userId  = payload.user_id;
  const chain   = payload.chain;           // "TRC20" or "LTC"
  const amount  = parseFloat(payload.value || '0'); // actual crypto received

  if (!userId || !chain || amount <= 0) {
    return res.status(400).send('Missing fields');
  }

  const db      = initFirebase();
  const userRef = db.collection('users').doc(userId);
  const depKey  = `dep_${Date.now()}`;

  try {
    if (chain === 'TRC20') {
      // 1 USDT = 1,000,000 USDT Coins
      const usdtCoins = Math.floor(amount * 1_000_000);
      await userRef.update({
        coins: FieldValue.increment(usdtCoins),
        [`deposits.${depKey}`]: {
          type: 'USDT', amount, coins_added: usdtCoins, at: new Date()
        },
      });
      console.log(`+${usdtCoins} USDT Coins → user ${userId}`);

    } else if (chain === 'LTC') {
      // 1 LTC = 100,000,000 LTC Coins (1 coin = 1 satoshi)
      const ltcCoins = Math.floor(amount * 100_000_000);
      await userRef.update({
        ltc: FieldValue.increment(ltcCoins),
        [`deposits.${depKey}`]: {
          type: 'LTC', amount, ltc_coins_added: ltcCoins, at: new Date()
        },
      });
      console.log(`+${ltcCoins} LTC Coins → user ${userId}`);
    }

    // CCPayment requires "success" string in body, else retries up to 6x
    return res.status(200).send('success');

  } catch (e) {
    console.error('Firebase error:', e.message);
    return res.status(500).send('Firebase error');
  }
}
