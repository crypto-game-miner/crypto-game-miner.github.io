// api/deposit-address.js
// POST { userId, currency: "USDT" | "LTC" }
// Returns { address, memo? }

import crypto from 'crypto';

const APP_ID     = process.env.CCPAYMENT_APP_ID;
const APP_SECRET = process.env.CCPAYMENT_APP_SECRET;

// Chain names for CCPayment deposit address API
const CHAINS = {
  USDT: 'TRC20',
  LTC:  'LTC',
};

function makeSignature(body, timestamp) {
  const raw = APP_ID + APP_SECRET + timestamp + body;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, currency } = req.body;
  if (!userId || !CHAINS[currency]) {
    return res.status(400).json({ error: 'Missing userId or invalid currency' });
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyObj = {
    user_id:    userId,
    chain:      CHAINS[currency],
    notify_url: `${process.env.SITE_URL}/api/deposit-webhook`,
  };
  const bodyStr = JSON.stringify(bodyObj);
  const sign    = makeSignature(bodyStr, timestamp);

  try {
    const response = await fetch('https://admin.ccpayment.com/ccpayment/v1/payment/address/get', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Appid':        APP_ID,
        'Sign':         sign,
        'Timestamp':    timestamp,
      },
      body: bodyStr,
    });

    const data = await response.json();

    if (data.code === 10000) {
      return res.status(200).json({
        address:  data.data.address,
        memo:     data.data.memo || '',
        currency,
      });
    } else {
      return res.status(400).json({ error: data.msg || 'CCPayment error', code: data.code });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
