export default {
  name: 'telegram',
  configured: (cfg) => Boolean(cfg.telegram?.botToken && cfg.telegram?.chatId),
  async send(cfg, alert, fetchImpl = fetch) {
    const { botToken, chatId } = cfg.telegram;
    const text = [`*${escapeMd(alert.title)}*`, escapeMd(alert.body), alert.url ? `[Open listing](${alert.url})` : '']
      .filter(Boolean)
      .join('\n\n');
    const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_notification: alert.urgency === 'low',
        link_preview_options: { is_disabled: false },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`telegram HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  },
};

// Telegram's legacy Markdown parser chokes on unbalanced control characters.
const escapeMd = (s) => String(s).replace(/([_*`[\]])/g, '\\$1');
