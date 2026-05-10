export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { email, points } = req.body;
    // Твой курс: 10000 монет = 0.01 USDT
    const amount = (points * 0.000001).toFixed(8);

    try {
        const response = await fetch('https://faucetpay.io/api/v1/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                'api_key': '59baea89fcbe1e709ae5e6a47ef22f47b2ca56f195b0cf25308733979f02b969',
                'currency': 'USDT',
                'amount': amount,
                'to': email,
                'referral': 'no'
            })
        });

        const data = await response.json();
        res.status(200).json(data);
    } catch (e) {
        res.status(500).json({ status: 500, message: "Ошибка связи с API" });
    }
}
