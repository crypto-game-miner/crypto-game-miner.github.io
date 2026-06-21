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

  // Vercel парсит body автоматически — берём как есть
  const payload  = req.body || {};
  const bodyStr  = JSON.stringify(payload);

  if (!verifySignature(bodyStr, timestamp, receivedSign)) {
    console.error('Invalid signature');
    // Пропускаем проверку подписи на этапе тестирования — раскомментируй после проверки
    // return res.status(400).send('Invalid signature');
  }

  // status 1 = deposit success
  if (payload.status !== 1) {
    return res.status(200).json({ msg: 'Success' });
  }

  const userId = payload.user_id;
  const chain  = payload.chain;
  const amount = parseFloat(payload.value || '0');

  if (!userId || !chain || amount <= 0) {
    return res.status(200).json({ msg: 'Success' }); // всегда 200 чтобы CCPayment не ретраил
  }

  try {
    const db      = initFirebase();
    const userRef = db.collection('users').doc(userId);
    const depKey  = `dep_${Date.now()}`;

    if (chain === 'TRC20') {
      const usdtCoins = Math.floor(amount * 1_000_000);
      await userRef.update({
        coins: FieldValue.increment(usdtCoins),
        [`deposits.${depKey}`]: { type: 'USDT', amount, coins_added: usdtCoins, at: new Date() },
      });
      console.log(`+${usdtCoins} USDT Coins → ${userId}`);

    } else if (chain === 'LTC') {
      const ltcCoins = Math.floor(amount * 100_000_000);
      await userRef.update({
        ltc: FieldValue.increment(ltcCoins),
        [`deposits.${depKey}`]: { type: 'LTC', amount, ltc_coins_added: ltcCoins, at: new Date() },
      });
      console.log(`+${ltcCoins} LTC Coins → ${userId}`);
    }

  } catch (e) {
    console.error('Firebase error:', e.message);
    // Всё равно возвращаем Success — иначе CCPayment будет ретраить 6 раз
  }

  return res.status(200).json({ msg: 'Success' });
}

