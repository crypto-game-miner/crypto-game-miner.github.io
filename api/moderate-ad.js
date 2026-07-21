// api/moderate-ad.js
// The ONLY place allowed to change ad_requests status and create/delete
// ad_slots documents. admin.html calls this instead of writing to
// Firestore directly, because the security rules block client writes
// to these collections (allow update, delete: if false).

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

// No client-visible fallback anymore — this is the only place the real
// password exists, and it only lives in Vercel's env vars.
const ADMIN_SECRET = process.env.ADMIN_SECRET;

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

  if (!ADMIN_SECRET) {
    console.error('ADMIN_SECRET env var is not set');
    return res.status(500).json({ success: false, error: 'Server misconfigured' });
  }

  const {
    secret, action, reqId, views, bannerUrl, clickUrl,
    usdtPool, ltcPool, rewardGuest, rewardLogged, dailyLinkUrl,
    minUsdt, maxUsdt, minLtc, maxLtc,
  } = req.body || {};

  if (secret !== ADMIN_SECRET) {
    return res.status(403).json({ success: false, error: 'Invalid admin password' });
  }

  const db = initFirebase();

  // Just confirms the password is correct — no side effects. Used by
  // admin.html's login screen so the real password never has to be
  // written into client-side JS to be compared there.
  if (action === 'verify') {
    return res.status(200).json({ success: true });
  }

  // set_pools doesn't touch ad_requests, so it's handled before the reqId check.
  if (action === 'set_pools') {
    function parsePool(val) {
      if (val === null || val === undefined || val === '') return null;
      const n = parseFloat(val);
      if (!isFinite(n) || n < 0) return undefined;
      return n;
    }
    const usdt = parsePool(usdtPool);
    const ltc  = parsePool(ltcPool);
    if (usdt === undefined || ltc === undefined) {
      return res.status(400).json({ success: false, error: 'Pools must be non-negative numbers, or blank to disable.' });
    }
    try {
      await db.collection('stats').doc('global').set({
        usdt_pool: usdt,
        ltc_pool: ltc,
        poolsUpdatedAt: Timestamp.now(),
      }, { merge: true });
      return res.status(200).json({ success: true, usdt_pool: usdt, ltc_pool: ltc });
    } catch (e) {
      console.error('Set-pools error:', e.message || e);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }

  if (action === 'set_claim_rewards') {
    const g = parseFloat(rewardGuest);
    const l = parseFloat(rewardLogged);
    if (!isFinite(g) || g < 0 || !isFinite(l) || l < 0) {
      return res.status(400).json({ success: false, error: 'Rewards must be non-negative numbers.' });
    }
    try {
      await db.collection('stats').doc('global').set({
        usdt_reward_guest: g,
        usdt_reward_logged: l,
        rewardsUpdatedAt: Timestamp.now(),
      }, { merge: true });
      return res.status(200).json({ success: true, usdt_reward_guest: g, usdt_reward_logged: l });
    } catch (e) {
      console.error('Set-claim-rewards error:', e.message || e);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }

  if (action === 'set_daily_link') {
    const url = (dailyLinkUrl || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ success: false, error: 'Must be a valid http(s) URL.' });
    }
    try {
      await db.collection('stats').doc('global').set({
        daily_link_url: url,
        dailyLinkUpdatedAt: Timestamp.now(),
      }, { merge: true });
      return res.status(200).json({ success: true, daily_link_url: url });
    } catch (e) {
      console.error('Set-daily-link error:', e.message || e);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }

  if (action === 'set_withdraw_limits') {
    function parseLimit(val) {
      const n = parseFloat(val);
      return (isFinite(n) && n >= 0) ? n : undefined;
    }
    const pMinUsdt = parseLimit(minUsdt);
    const pMaxUsdt = parseLimit(maxUsdt);
    const pMinLtc  = parseLimit(minLtc);
    const pMaxLtc  = parseLimit(maxLtc);
    if ([pMinUsdt, pMaxUsdt, pMinLtc, pMaxLtc].some(v => v === undefined)) {
      return res.status(400).json({ success: false, error: 'All four values must be non-negative numbers.' });
    }
    if (pMinUsdt > pMaxUsdt || pMinLtc > pMaxLtc) {
      return res.status(400).json({ success: false, error: 'Min cannot be greater than max (daily limit).' });
    }
    try {
      await db.collection('stats').doc('global').set({
        withdraw_min_usdt: pMinUsdt,
        withdraw_max_usdt: pMaxUsdt,
        withdraw_min_ltc: pMinLtc,
        withdraw_max_ltc: pMaxLtc,
        withdrawLimitsUpdatedAt: Timestamp.now(),
      }, { merge: true });
      return res.status(200).json({ success: true });
    } catch (e) {
      console.error('Set-withdraw-limits error:', e.message || e);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }

  if (!reqId) {
    return res.status(400).json({ success: false, error: 'Missing reqId' });
  }

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



