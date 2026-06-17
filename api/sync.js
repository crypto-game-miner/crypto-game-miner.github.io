const admin = require('firebase-admin');
const { google } = require('googleapis');

// Твой секретный ключ встроен прямо в код
const serviceAccount = {
  "type": "service_account",
  "project_id": "crypto-miner-game-f45dc",
  "private_key_id": "59614119da98281fdf08163a0f1c39e731eff7e6",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDUSqFzES7UT4FE\n2U+VMlc8LyZz2R2wCPN1VpDde2sgIXsR8gJQk0XVH0TOfpeU2ZkTw2Ja0RvzYDPx\npMr2nxDxTC41Un79+WsiMz4QlBnkT9wXa7ukY4O/gXd4xuPJBNJNgPZJmPW2YRxC\nh92Eet00bSrjmPHdk+R7bCqvnom0a4uIV2D7b1Fh48mM1g309LEBURFxXiyADfwM\nsj8glqiQLIUsVCO/Fz+sogVlp2ckjzEkd8fqSMrGka4TnNr/xtja/rlC3p6ErQr+\nvM4SCdt1G+M/Cc9trJg4BLCMDM5BOv1vue62JNCzlONs3DJk3UM2/t1+biZTcEcu\nripc+MuzAgMBAAECggEAEhJkWhJNZT97ZqwFLVNCv9nXsSb7cv/gEc4TuPcHsI2J\nF4b9kXRoDnOB/P4j00UO1fLdDZQdiANZiKmZqZLy80ej62AhdWdlKl0oXGrvJVNz\nDf9a0uyxy3yu+fYccAFcEcL3tF40FJmBuVwtjFiVOiBM9WEQvecYHTWhEKAzYstZ\nNbffn3dlPuBDKQZ3S9V0/iSPe3XYYKjwYy+FovAx3VsW1Z99q9YcOpGz4QYW9Mvz\nRgs2zVb2uyWlvR+8+0ffbDWVfZz9DSCfPpTTP8b+abVlUp4IsicQYPpiF3AK6rNF\nTm9GVzeerevztcr/cJxzHVpoNv4lIF8yIxIctTRl8QKBgQDyeCOt3GReVu4wyYZO\nOrTFqKBL7bPYbICR5oZmJaU6Y/kiFmHnTNZ+R/syvK4H/vDx7+mzNHbdx0NmO7Iw\nzz+HqbxVMYizK8Cng4DE1QfQsMaktqcAVN9y55GEpqMbd8eAc2jKx+g++WvMCWb7\ntzmCDCNx8B0siR15L2EhHF5WiQKBgQDgI2DtkJxUoXF8/Q2/5bcj2dXRrFn9JPmF\nTuBrJy9uj3R9toiXm4PK3EfRS8fE+VeUJCa0vIe5anqcsqKSjqXv3Rp7yCu4IgMt\nU35lQjpV/QLsNkdmg2gIoiN2svpFIVxcdzhHvsq63MaXGhlWohTUxRplY4ihY7Tu\np/e+We2BWwKBgQC/9edhZQO9QJtw2otO8eFeP0Mw+a6RoE0ltVkgE5u9H5sEpq25\n/jYuYfR41bH+OJMvJ55gtx+IM5KjpI1NYTbNw86LsBympPPwawcOTg3S5bFOhCCw\n/YCuKrElUPv+6hRzGGuVZzDycmsqbSMwE34e/FcvhEbElIVWBPGj0h7J6QKBgAXM\nBHLAfbqWnlfMN7HR4CW2OZh9q6onbair/JPo5IoofavOr8O0CvmRLu5T1mvawxAa\ny0F7ass53Mf2usutks8cWdX/vFm7z3c5pJg72URmEdBIKxqUpXkrsF0ejeiBz2C4\n2KTKY3Xnxd8clrEt6foCywb6Rwtdh81wXLD4pHLnAoGBAKyageCow9t/z2QMWuQN\nS9JiBAfmLXI4zpHJ83VVaZWb7ZhPS1AZX1DeLV1ZS4quh6qKfHCla1iV7+RuMOug\nDVFS5nUq1fis1ppM1wVn5T1MUgeLXWfAM0Kbox+qyJMbzkZAekEYStWh1G4J2gii\nfEFRLzBetS00kHij8Eb2op9O\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk-fbsvc@crypto-miner-game-f45dc.iam.gserviceaccount.com",
  "client_id": "103990800927869706071",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40crypto-miner-game-f45dc.iam.gserviceaccount.com",
  "universe_domain": "googleapis.com"
};

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


