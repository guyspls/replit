export default {
  name: 'slack',
  configured: (cfg) => Boolean(cfg.slack?.webhookUrl),
  async send(cfg, alert, fetchImpl = fetch) {
    const payload = {
      text: alert.title,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: alert.title.slice(0, 150), emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: alert.body.slice(0, 3000) } },
        ...(alert.url
          ? [
              {
                type: 'actions',
                elements: [
                  {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Open listing' },
                    url: alert.url,
                    style: alert.urgency === 'max' ? 'primary' : undefined,
                  },
                ],
              },
            ]
          : []),
      ],
    };
    const res = await fetchImpl(cfg.slack.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`slack HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  },
};
