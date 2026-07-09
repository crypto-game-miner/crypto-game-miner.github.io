// api/submit-ad.js
// The ONLY place allowed to deduct USDT/LTC coins for an ad purchase and
// create the ad_requests document. Client sends the form data + uid,
// server verifies balance and does everything in a transaction.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const PRICE_LTC  = 220;
const PRICE_USDT = 100;

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

  const { uid, currency, days, bannerUrl, clickUrl, contact } = req.body || {};

  if (!uid) return res.status(400).json({ error: 'Missing uid' });
  if (currency !== 'ltc' && currency !== 'usdt') {
    return res.status(400).json({ error: 'Invalid currency' });
  }
  const numDays = parseInt(days) || 1;
  if (numDays < 1) return res.status(400).json({ error: 'Invalid days' });
  if (!bannerUrl || !bannerUrl.startsWith('http')) {
    return res.status(400).json({ error: 'Invalid banner URL' });
  }
  if (!clickUrl || !clickUrl.startsWith('http')) {
    return res.status(400).json({ error: 'Invalid click URL' });
  }
  if (!contact || !contact.includes('@')) {
    return res.status(400).json({ error: 'Invalid contact email' });
  }

  const db = initFirebase();
  const userRef = db.collection('users').doc(uid);

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) {
        throw { code: 'NO_USER', message: 'User not found. Please sign in again.' };
      }
      const data = snap.data();

      const price   = currency === 'ltc' ? PRICE_LTC : PRICE_USDT;
      const total   = price * numDays;
      const field   = currency === 'ltc' ? 'ltc' : 'coins';
      const balance = data[field] || 0;

      if (balance < total) {
        throw {
          code: 'INSUFFICIENT_FUNDS',
          message: `Not enough ${currency.toUpperCase()} coins. Need ${total}, you have ${balance}.`,
        };
      }

      const newBalance = balance - total;
      tx.update(userRef, { [field]: newBalance });

      const adRef = db.collection('ad_requests').doc();
      tx.set(adRef, {
        uid,
        contact,
        banner_url: bannerUrl,
        click_url: clickUrl,
        days: numDays,
        currency,
        cost: total,
        status: 'pending',
        paid: true,
        createdAt: Timestamp.now(),
      });

      return { newBalance, field, total };
    });

    return res.status(200).json({ success: true, ...result });

  } catch (e) {
    if (e.code === 'NO_USER' || e.code === 'INSUFFICIENT_FUNDS') {
      return res.status(400).json({ success: false, error: e.message, code: e.code });
    }
    console.error('Submit-ad error:', e.message || e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

