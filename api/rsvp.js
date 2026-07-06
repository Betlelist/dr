// Серверная функция Vercel.
// Хранит список гостей в Upstash Redis и поддерживает ОДНО сообщение
// в Telegram, которое редактируется при каждом изменении списка.
//
// Переменные окружения:
//   TELEGRAM_BOT_TOKEN  — токен бота от BotFather
//   TELEGRAM_CHAT_ID    — id личного чата или закрытой группы
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN — создаются автоматически
//     при подключении Upstash Redis через Vercel Marketplace (см. README)

const STATE_KEY = 'vice35:state';
const MAX_GUESTS = 200;          // потолок на случай злоупотреблений
const RATE_LIMIT = 8;            // не больше 8 действий в час с одного IP
const RATE_WINDOW_SEC = 3600;

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

async function redis(...cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  if (j.error) throw new Error('Redis: ' + j.error);
  return j.result;
}

async function tg(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return r.json();
}

function buildListText(state) {
  const guests = Object.values(state.guests)
    .sort((a, b) => a.ts - b.ts);

  let adults = 0, withKids = 0;
  const lines = guests.map((g, i) => {
    const n = g.pair === 'couple' ? 2 : 1;
    adults += n;
    if (g.kids === 'yes') withKids++;
    const pairLabel = g.pair === 'couple' ? '💑 с парой' : '🙋 один/одна';
    const kidsLabel = g.kids === 'yes' ? ' · 👶 с детьми' : '';
    return `${i + 1}. ${g.name} — ${pairLabel}${kidsLabel}`;
  });

  const updated = new Date().toLocaleString('ru-RU', {
    timeZone: 'Asia/Bishkek',
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });

  return (
    `🌴 VICE CITY PARTY: 35 YEARS\n` +
    `Список гостей (обновляется автоматически)\n\n` +
    (lines.length ? lines.join('\n') : '— пока никто не подтвердил —') +
    `\n\n👥 Взрослых: ${adults}` +
    `\n📝 Заявок: ${guests.length}` +
    `\n👶 Семей с детьми: ${withKids}` +
    `\n\n🕐 Обновлено: ${updated}`
  );
}

// Отправляет новое сообщение со списком или редактирует существующее
async function syncTelegram(state) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const text = buildListText(state);

  if (state.messageId) {
    const res = await tg('editMessageText', {
      chat_id: chatId, message_id: state.messageId, text
    });
    if (res.ok) return state.messageId;
    // "message is not modified" — не ошибка, список просто не изменился
    if (res.description && res.description.includes('not modified')) return state.messageId;
    // Сообщение удалили вручную — отправим новое
  }
  const sent = await tg('sendMessage', { chat_id: chatId, text });
  if (!sent.ok) throw new Error('Telegram: ' + (sent.description || 'send failed'));
  return sent.result.message_id;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  if (!REDIS_URL || !REDIS_TOKEN || !process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    return res.status(500).json({ ok: false, error: 'Server not configured' });
  }

  const { action, deviceId, name, pair, kids, website } = req.body || {};

  // Ловушка для спам-ботов: людям это поле не видно
  if (website) return res.status(200).json({ ok: true });

  // Валидация идентификатора устройства
  if (typeof deviceId !== 'string' || deviceId.length < 8 || deviceId.length > 64 ||
      !/^[\w-]+$/.test(deviceId)) {
    return res.status(400).json({ ok: false, error: 'Invalid device' });
  }

  try {
    // Лимит действий по IP — от розыгрышей со спамом
    const ip = (req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
    const rlKey = `vice35:rl:${ip}`;
    const hits = await redis('INCR', rlKey);
    if (hits === 1) await redis('EXPIRE', rlKey, RATE_WINDOW_SEC);
    if (hits > RATE_LIMIT) {
      return res.status(429).json({ ok: false, error: 'Too many requests' });
    }

    // Читаем текущее состояние
    const raw = await redis('GET', STATE_KEY);
    const state = raw ? JSON.parse(raw) : { guests: {}, messageId: null };

    if (action === 'confirm') {
      const cleanName = typeof name === 'string' ? name.trim().slice(0, 80) : '';
      if (!cleanName || !['solo', 'couple'].includes(pair) || !['yes', 'no'].includes(kids)) {
        return res.status(400).json({ ok: false, error: 'Invalid data' });
      }
      const isNew = !state.guests[deviceId];
      if (isNew && Object.keys(state.guests).length >= MAX_GUESTS) {
        return res.status(409).json({ ok: false, error: 'List is full' });
      }
      // Повторная отправка с того же устройства не создаёт дубль,
      // а обновляет существующую запись
      state.guests[deviceId] = {
        name: cleanName, pair, kids,
        ts: state.guests[deviceId]?.ts || Date.now()
      };
    } else if (action === 'cancel') {
      if (!state.guests[deviceId]) {
        return res.status(200).json({ ok: true }); // уже нет в списке — всё в порядке
      }
      delete state.guests[deviceId];
    } else {
      return res.status(400).json({ ok: false, error: 'Unknown action' });
    }

    // Обновляем сообщение в Telegram и сохраняем состояние
    state.messageId = await syncTelegram(state);
    await redis('SET', STATE_KEY, JSON.stringify(state));

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
};
