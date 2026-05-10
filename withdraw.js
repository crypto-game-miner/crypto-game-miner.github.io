export default async function handler(req, res) {
    // Разрешаем запросы с любого домена (чтобы не было ошибок CORS)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method === 'POST') {
        const { email, points } = req.body;

        // Конвертация: 100 монет = 0.001 USDT (можешь поправить под себя)
        const amount = (points / 100000).toFixed(8); 

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
            
            // Отправляем ответ обратно в игру
            return res.status(200).json(data);
        } catch (error) {
            return res.status(500).json({ status: 500, message: 'Ошибка связи с FaucetPay' });
        }
    } else {
        res.status(405).json({ message: 'Only POST allowed' });
    }
}

