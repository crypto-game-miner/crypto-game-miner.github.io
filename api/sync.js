const admin = require('firebase-admin');
const { google } = require('googleapis');

// Подгружаем твой ключ, который лежит в корне проекта
const serviceAccount = require('../key.json');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();
const SHEET_ID = '16YpAdNhuKwvKht-e0fqx-l-LYhDslGTivadaceaPUwI';

module.exports = async (req, res) => {
    try {
        const snapshot = await db.collection('users').get();
        if (snapshot.empty) {
            return res.status(200).send("Юзеры не найдены в базе.");
        }

        let totalPlayers = 0;
        let totalHashrate = 0;
        let leaderboard = [];

        snapshot.forEach(doc => {
            const data = doc.data();
            totalPlayers++;
            const hashrate = parseFloat(data.hashrate) || 0;
            totalHashrate += hashrate;

            leaderboard.push({
                email: data.email || 'Аноним',
                hashrate: hashrate,
                coins: parseInt(data.coins) || 0
            });
        });

        leaderboard.sort((a, b) => b.hashrate - a.hashrate);
        const top50 = leaderboard.slice(0, 50);

        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: serviceAccount.client_email,
                private_key: serviceAccount.private_key,
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const sheets = google.sheets({ version: 'v4', auth });

        // Запись Общей статистики
        const mainStats = [
            ["Параметр", "Значение"],
            ["Всего игроков", totalPlayers],
            ["Общая мощность сети (GH/s)", totalHashrate.toFixed(2)],
            ["Последнее обновление", new Date().toLocaleString("ru-RU")]
        ];

        await sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_ID,
            range: 'Общая статистика!A1',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: mainStats }
        });

        // Запись Лидеров
        const leaderboardRows = [
            ["Место", "Email / Игрок", "Мощность (GH/s)", "Монеты (Coins)"]
        ];
        top50.forEach((player, index) => {
            leaderboardRows.push([index + 1, player.email, player.hashrate, player.coins]);
        });

        await sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_ID,
            range: 'Топ лидеров!A1',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: leaderboardRows }
        });

        return res.status(200).send("Таблица в Google Sheets успешно обновлена!");
    } catch (error) {
        return res.status(500).send("Ошибка: " + error.message);
    }
};
