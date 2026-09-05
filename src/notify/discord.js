export default {
  name: 'discord',
  configured: (cfg) => Boolean(cfg.discord?.webhookUrl),
  async send(cfg, alert, fetchImpl = fetch) {
    const color = { max: 0x22c55e, high: 0x3b82f6, default: 0xeab308, low: 0x94a3b8 }[alert.urgency] ?? 0x94a3b8;
    const payload = {
      username: 'scalper-bot',
      content: alert.urgency === 'max' ? `@here ${alert.title}` : undefined,
      embeds: [
        {
          title: alert.title.slice(0, 256),
          url: alert.url,
          description: alert.body.slice(0, 4096),
          color,
          timestamp: new Date(alert.at ?? Date.now()).toISOString(),
          fields: alert.fields?.slice(0, 25).map((f) => ({
            name: String(f.name).slice(0, 256),
            value: String(f.value).slice(0, 1024),
            inline: true,
          })),
        },
      ],
    };
    const res = await fetchImpl(cfg.discord.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`discord HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  },
};
