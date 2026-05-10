export default async function handler(req, res) {
    // CORS — разрешаем запросы с GitHub Pages
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ status: 405, message: 'Method not allowed' });

    // Читаем данные из запроса
    const body = req.body || {};
    const email = body.email;
    const points = Number(body.points);

    // Проверяем что данные пришли
    if (!email || !points || isNaN(points)) {
        return res.status(400).json({ status: 400, message: 'Missing email or points' });
    }

    // 10 000 монет = 0.01 USDT
    const amount = (points * 0.000001).toFixed(8);

    try {
        const fpResponse = await fetch('https://faucetpay.io/api/v1/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                api_key:  '59baea89fcbe1e709ae5e6a47ef22f47b2ca56f195b0cf25308733979f02b969',
                currency: 'USDT',
                amount:   amount,
                to:       email,
                referral: 'no',
            }),
        });

        // Читаем ответ как текст, чтобы не падать если не JSON
        const text = await fpResponse.text();

        let data;
        try {
            data = JSON.parse(text);
        } catch {
            console.error('FaucetPay вернул не-JSON:', text);
            return res.status(502).json({ status: 502, message: 'FaucetPay error: ' + text });
        }

        // Возвращаем ответ FaucetPay клиенту как есть
        return res.status(200).json(data);

    } catch (e) {
        console.error('Ошибка при запросе к FaucetPay:', e.message);
        return res.status(500).json({ status: 500, message: 'Server error: ' + e.message });
    }
}

