// api/moderate-ad.js
// The ONLY place allowed to change ad_requests status or write ad_slots.
// admin.html calls this instead of writing to Firestore directly,
// because Firestore rules block client writes to these collections.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const ADMIN_SECRET = process.env.ADMIN_PANEL_SECRET; // set this in Vercel env vars

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

  const { secret, action, reqId, days, bannerUrl, clickUrl } = req.body || {};

  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!reqId) return res.status(400).json({ error: 'Missing reqId' });

  const db = initFirebase();
  const reqRef = db.collection('ad_requests').doc(reqId);

  try {
    if (action === 'approve') {
      const numDays = parseInt(days) || 1;
      const paidUntil = new Date();
      paidUntil.setDate(paidUntil.getDate() + numDays);

      const slotRef = db.collection('ad_slots').doc();
      await db.runTransaction(async (tx) => {
        tx.update(reqRef, { status: 'active' });
        tx.set(slotRef, {
          banner_url: bannerUrl,
          click_url: clickUrl,
          status: 'active',
          paid_until: Timestamp.fromDate(paidUntil),
          days: numDays,
          req_id: reqId,
          createdAt: Timestamp.now(),
        });
      });
      return res.status(200).json({ success: true, slotId: slotRef.id });

    } else if (action === 'reject') {
      await reqRef.update({ status: 'rejected' });
      return res.status(200).json({ success: true });

    } else if (action === 'revoke') {
      // Undo an approval: set request back to pending, deactivate its slot(s)
      const slotsSnap = await db.collection('ad_slots').where('req_id', '==', reqId).get();
      const batch = db.batch();
      slotsSnap.forEach(doc => batch.delete(doc.ref));
      batch.update(reqRef, { status: 'pending' });
      await batch.commit();
      return res.status(200).json({ success: true });

    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (e) {
    console.error('Moderate-ad error:', e.message || e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

