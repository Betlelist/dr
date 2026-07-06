// Серверная функция Vercel: принимает подтверждение с сайта
// и отправляет сообщение твоему Telegram-боту.
// Токен и chat_id хранятся в переменных окружения — гости их не видят.

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const { name, pair, kids, website } = req.body || {};

  // Ловушка для ботов: у людей это поле скрыто и всегда пустое.
  // Ботам отвечаем "ок", но ничего не отправляем.
  if (website) {
    return res.status(200).json({ ok: true });
  }

  // Валидация
  const cleanName = typeof name === 'string' ? name.trim().slice(0, 80) : '';
  if (!cleanName || !['solo', 'couple'].includes(pair) || !['yes', 'no'].includes(kids)) {
    return res.status(400).json({ ok: false, error: 'Invalid data' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return res.status(500).json({ ok: false, error: 'Server not configured' });
  }

  const adults = pair === 'couple' ? 2 : 1;
  const time = new Date().toLocaleString('ru-RU', {
    timeZone: 'Asia/Bishkek',
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });

  const text =
    `🎉 Новое подтверждение!\n\n` +
    `👤 ${cleanName}\n` +
    `${pair === 'couple' ? '💑 С парой (взрослых: 2)' : '🙋 Один/одна (взрослых: 1)'}\n` +
    `${kids === 'yes' ? '👶 С детьми: да' : '🚫 Без детей'}\n\n` +
    `🕐 ${time}`;

  try {
    const tg = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    if (!tg.ok) {
      const detail = await tg.text();
      console.error('Telegram error:', detail);
      return res.status(502).json({ ok: false, error: 'Telegram error' });
    }
    return res.status(200).json({ ok: true, adults });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Send failed' });
  }
};
