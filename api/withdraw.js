export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ status: 405, message: 'Method not allowed' });

    const body     = req.body || {};
    const email    = body.email;
    const points   = Number(body.points);
    const currency = (body.currency || 'usdt').toLowerCase(); // 'usdt' or 'ltc'

    if (!email || !points || isNaN(points)) {
        return res.status(400).json({ status: 400, message: 'Missing email or points' });
    }

    let amount;
    let fpCurrency;

    if (currency === 'usdt') {
        // 10000 USDT Coins = 0.01 USDT = 1000 satoshi-equivalent
        // FaucetPay USDT amount in smallest unit (satoshi-like)
        // 1 USDT Coin = 0.000001 USDT → points * 0.000001 USDT
        // FaucetPay expects amount in satoshis: 1 USDT = 100000000
        amount = Math.round(points * 100); // 1 USDT Coin = 100 units
        fpCurrency = 'USDT';
    } else {
        // LTC: 1 LTC Coin = 1 satoshi = 0.00000001 LTC
        // FaucetPay LTC amount in satoshis
        amount = Math.round(points); // 1 LTC Coin = 1 satoshi
        fpCurrency = 'LTC';
    }

    try {
        const fpResponse = await fetch('https://faucetpay.io/api/v1/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                api_key:  process.env.FAUCETPAY_API_KEY,
                currency: fpCurrency,
                amount:   amount,
                to:       email,
                referral: 'no',
            }),
        });

        const text = await fpResponse.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            console.error('FaucetPay non-JSON:', text);
            return res.status(502).json({ status: 502, message: 'FaucetPay error: ' + text });
        }

        return res.status(200).json(data);
    } catch (e) {
        console.error('Withdraw error:', e.message);
        return res.status(500).json({ status: 500, message: 'Server error: ' + e.message });
    }
}


