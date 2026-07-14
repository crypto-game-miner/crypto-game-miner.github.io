// api/moderate-ad.js
// The ONLY place allowed to change ad_requests status and create/delete
// ad_slots documents. admin.html calls this instead of writing to
// Firestore directly, because the security rules block client writes
// to these collections (allow update, delete: if false).

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

// Prefer an env var so the secret isn't duplicated between client and server.
// Falls back to the same value used in admin.html if the env var isn't set.
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'kr1stal2024';

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

  const { secret, action, reqId, views, bannerUrl, clickUrl } = req.body || {};

  if (secret !== ADMIN_SECRET) {
    return res.status(403).json({ success: false, error: 'Invalid admin password' });
  }
  if (!reqId) {
    return res.status(400).json({ success: false, error: 'Missing reqId' });
  }

  const db = initFirebase();
  const reqRef = db.collection('ad_requests').doc(reqId);

  try {
    if (action === 'approve') {
      const numViews = parseInt(views) || 1;
      if (!bannerUrl || !clickUrl) {
        return res.status(400).json({ success: false, error: 'Missing bannerUrl/clickUrl' });
      }

      const slotRef = db.collection('ad_slots').doc();
      await db.runTransaction(async (tx) => {
        tx.update(reqRef, { status: 'active' });
        tx.set(slotRef, {
          banner_url: bannerUrl,
          click_url: clickUrl,
          status: 'active',
          views_total: numViews,
          views_shown: 0,
          req_id: reqId,
          createdAt: Timestamp.now(),
        });
      });
      return res.status(200).json({ success: true });
    }

    if (action === 'reject') {
      await reqRef.update({ status: 'rejected' });
      return res.status(200).json({ success: true });
    }

    if (action === 'revoke') {
      // Find and delete any ad_slots created for this request, then move
      // the request back to pending.
      const slotsSnap = await db.collection('ad_slots').where('req_id', '==', reqId).get();
      const batch = db.batch();
      slotsSnap.forEach(doc => batch.delete(doc.ref));
      batch.update(reqRef, { status: 'pending' });
      await batch.commit();
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ success: false, error: 'Unknown action' });

  } catch (e) {
    console.error('Moderate-ad error:', e.message || e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

