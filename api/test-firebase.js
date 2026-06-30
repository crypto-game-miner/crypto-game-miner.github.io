// api/test-firebase.js
// Simple test - just tries to write {test: true} to Firestore
// If UNAUTHENTICATED error - credentials problem in Vercel
// If success - Firebase Admin SDK works fine

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

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

  try {
    const db = initFirebase();

    // Log what credentials we have (safely)
    const projectId   = process.env.FIREBASE_PROJECT_ID || 'MISSING';
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || 'MISSING';
    const keyStart    = process.env.FIREBASE_PRIVATE_KEY?.substring(0, 30) || 'MISSING';

    // Try a simple write
    await db.collection('test').doc('ping').set({
      test: true,
      time: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      projectId,
      clientEmail,
      keyStart,
      message: 'Firebase Admin SDK works!'
    });

  } catch (e) {
    return res.status(500).json({
      success: false,
      error: e.message,
      code: e.code,
      projectId:   process.env.FIREBASE_PROJECT_ID || 'MISSING',
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL || 'MISSING',
      keyStart:    process.env.FIREBASE_PRIVATE_KEY?.substring(0, 30) || 'MISSING',
    });
  }
}
