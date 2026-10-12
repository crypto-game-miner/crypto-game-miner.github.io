// api/deposit-webhook.js

import crypto from 'crypto';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// Нужно сырое тело запроса для проверки подписи
export const config = { api: { bodyParser: false } };

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

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function signFor(bodyStr, timestamp) {
  const raw = APP_ID + APP_SECRET + timestamp + bodyStr;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifySignature(rawBody, payload, timestamp, receivedSign) {
  if (!receivedSign || !timestamp) return false;
  // Сначала по сырому телу, потом по JSON.stringify (как было раньше)
  if (safeEqual(signFor(rawBody, timestamp), receivedSign)) return true;
  if (safeEqual(signFor(JSON.stringify(payload), timestamp), receivedSign)) return true;
  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const timestamp    = req.headers['timestamp'] || '';
  const receivedSign = req.headers['sign']      || '';

  const rawBody = await readRawBody(req);

  let payload;
  try {
    payload = JSON.parse(rawBody || '{}');
  } catch (e) {
    console.error('Bad JSON body');
    return res.status(400).send('Bad request');
  }

  if (!verifySignature(rawBody, payload, timestamp, receivedSign)) {
    console.error('Invalid signature — rejected');
    return res.status(401).send('Invalid signature');
  }

  // Реальная структура: { type: "DirectDeposit", msg: { referenceId, coinSymbol, status, amount, ... } }
  const msg = payload.msg || payload;

  if (msg.status !== 'Success') {
    return res.status(200).json({ msg: 'Success' });
  }

  const userEmail  = msg.referenceId;
  const coinSymbol = msg.coinSymbol;
  const amount     = parseFloat(msg.amount || msg.value || '0');

  if (!userEmail || !coinSymbol || amount <= 0) {
    console.log('Missing data:', { userEmail, coinSymbol, amount });
    return res.status(200).json({ msg: 'Success' });
  }

  try {
    const db = initFirebase();

    // Ищем документ юзера по полю email, а не по ID документа
    const snap = await db.collection('users').where('email', '==', userEmail).limit(1).get();

    if (snap.empty) {
      console.error('User not found for email:', userEmail);
      return res.status(200).json({ msg: 'Success' });
    }

    const userRef = snap.docs[0].ref;
    const depKey  = `dep_${Date.now()}`;

    let update = null;

    if (coinSymbol === 'USDT') {
      const usdtCoins = Math.floor(amount * 1_000_000);
      update = {
        coins: FieldValue.increment(usdtCoins),
        [`deposits.${depKey}`]: { type: 'USDT', amount, coins_added: usdtCoins, at: new Date() },
      };
      console.log(`+${usdtCoins} USDT Coins → ${userEmail}`);

    } else if (coinSymbol === 'LTC') {
      const ltcCoins = Math.floor(amount * 100_000_000);
      update = {
        ltc: FieldValue.increment(ltcCoins),
        [`deposits.${depKey}`]: { type: 'LTC', amount, ltc_coins_added: ltcCoins, at: new Date() },
      };
      console.log(`+${ltcCoins} LTC Coins → ${userEmail}`);

    } else if (coinSymbol === 'SOL') {
      const solCoins = Math.floor(amount * 100_000_000);
      update = {
        sol: FieldValue.increment(solCoins),
        [`deposits.${depKey}`]: { type: 'SOL', amount, sol_coins_added: solCoins, at: new Date() },
      };
      console.log(`+${solCoins} SOL Coins → ${userEmail}`);
    }

    if (!update) {
      return res.status(200).json({ msg: 'Success' });
    }

    // Защита от повторной обработки одного и того же депозита
    const dedupeId = msg.recordId || msg.txId || null;
    const batch = db.batch();
    if (dedupeId) {
      const procRef = db.collection('processed_deposits').doc(String(dedupeId).replace(/\//g, '_'));
      batch.create(procRef, { email: userEmail, coinSymbol, amount, at: new Date() });
    }
    batch.update(userRef, update);

    try {
      await batch.commit();
    } catch (e) {
      // code 6 = ALREADY_EXISTS → этот депозит уже зачислен ранее
      if (e.code === 6) {
        console.log('Duplicate webhook ignored:', dedupeId);
        return res.status(200).json({ msg: 'Success' });
      }
      throw e;
    }

  } catch (e) {
    console.error('Firebase error:', e.message);
    // 500 → CCPayment повторит вебхук, депозит не потеряется
    return res.status(500).send('Error');
  }

  return res.status(200).json({ msg: 'Success' });
}

