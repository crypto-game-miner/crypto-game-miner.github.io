// api/deposit-address.js — CCPayment v2 API

import crypto from 'crypto';

const APP_ID     = process.env.CCPAYMENT_APP_ID;
const APP_SECRET = process.env.CCPAYMENT_APP_SECRET;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, currency } = req.body;
  if (!userId || !['USDT', 'LTC'].includes(currency)) {
    return res.status(400).json({ error: 'Missing userId or invalid currency' });
  }

  const chain     = currency === 'USDT' ? 'TRX' : 'LTC';
  const timestamp = Math.floor(Date.now() / 1000);

  const bodyObj = {
    referenceId: userId,
    chain:       chain,
  };
  const bodyStr = JSON.stringify(bodyObj);

  // v2 signature: HMAC-SHA256(appId + timestamp + body, appSecret)
  const signText = APP_ID + timestamp + bodyStr;
  const sign = crypto
    .createHmac('sha256', APP_SECRET)
    .update(signText)
    .digest('hex');

  try {
    const response = await fetch('https://ccpayment.com/ccpayment/v2/getOrCreateAppDepositAddress', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Appid':        APP_ID,
        'Sign':         sign,
        'Timestamp':    timestamp.toString(),
      },
      body: bodyStr,
    });

    const data = await response.json();
    console.log('CCPayment v2 response:', JSON.stringify(data));

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
    console.error('Fetch error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}





