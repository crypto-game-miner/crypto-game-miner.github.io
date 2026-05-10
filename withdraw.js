export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method === 'POST') {
        const { email, points } = req.body;

        // НОВЫЙ КУРС: 10 000 монет = 0.01 USDT
        // Формула: количество монет * 0.000001
        const amount = (points * 0.000001).toFixed(8);

        try {
            const params = new URLSearchParams({
                'api_key': '59baea89fcbe1e709ae5e6a47ef22f47b2ca56f195b0cf25308733979f02b969',
                'currency': 'USDT',
                'amount': amount,
                'to': email,
                'referral': 'no'
            });

            const fpResponse = await fetch('https://faucetpay.io/api/v1/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params
            });

            const data = await fpResponse.json();

            if (data.status !== 200) {
                return res.status(400).json({ 
                    status: data.status, 
                    message: data.message || 'Ошибка FaucetPay' 
                });
            }

            return res.status(200).json(data);
        } catch (error) {
            return res.status(500).json({ status: 500, message: 'Критическая ошибка сервера' });
        }
    } else {
        res.status(405).json({ message: 'Method Not Allowed' });
    }
}


