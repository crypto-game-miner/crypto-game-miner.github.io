const admin = require('firebase-admin');
const { google } = require('googleapis');

// 1. Подключаем твой скачанный JSON-ключ от Firebase
// Положи скачанный файл ключа в ту же папку, переименуй его в key.json
const serviceAccount = require('./key.json');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

// 2. Настройки Google Таблицы
const SHEET_ID = '16YpAdNhuKwvKht-e0fqx-l-LYhDslGTivadaceaPUwI'; // Твой ID из ссылки

const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: serviceAccount.client_email,
        private_key: serviceAccount.private_key,
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

async function updateTable() {
    try {
        console.log("Получаем юзеров из Firestore...");
        // Читаем коллекцию users
        const snapshot = await db.collection('users').get();
        
        if (snapshot.empty) {
            console.log("Юзеры не найдены.");
            return;
        }

        let totalPlayers = 0;
        let totalHashrate = 0;
        let leaderboard = [];

        snapshot.forEach(doc => {
            const data = doc.data();
            totalPlayers++;

            // Вытаскиваем хэшрейт (если поля нет, ставим 0)
            const hashrate = parseFloat(data.hashrate) || 0;
            totalHashrate += hashrate;

            // Собираем данные для топа
            leaderboard.push({
                email: data.email || 'Аноним',
                hashrate: hashrate,
                coins: parseInt(data.coins) || 0
            });
        });

        // Сортируем топ: у кого больше hashrate — тот выше
        leaderboard.sort((a, b) => b.hashrate - a.hashrate);
        
        // Берем ТОП-50 игроков для таблицы лидеров
        const top50 = leaderboard.slice(0, 50);

        // --- Запись Листа 1: Общая статистика ---
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

        // --- Запись Листа 2: Топ лидеров ---
        const leaderboardRows = [
            ["Место", "Email / Игрок", "Мощность (GH/s)", "Монеты (Coins)"]
        ];

        top50.forEach((player, index) => {
            leaderboardRows.push([
                index + 1,
                player.email,
                player.hashrate,
                player.coins
            ]);
        });

        await sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_ID,
            range: 'Топ лидеров!A1',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: leaderboardRows }
        });

        console.log("Таблица в Google Sheets успешно обновлена!");

    } catch (error) {
        console.error("Ошибка при обновлении таблицы:", error);
    }
}

// Запустить обновление прямо сейчас
updateTable();
