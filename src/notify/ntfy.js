/**
 * ntfy.sh — the fastest path from this bot to a phone lock screen.
 * Free, no account: pick an unguessable topic, install the app, subscribe.
 */
export default {
  name: 'ntfy',
  configured: (cfg) => Boolean(cfg.ntfy?.topic),
  async send(cfg, alert, fetchImpl = fetch) {
    const { topic, server = 'https://ntfy.sh', token, priorityMap = {} } = cfg.ntfy;
    const priority = priorityMap[alert.urgency] ?? { max: 5, high: 4, default: 3, low: 2 }[alert.urgency] ?? 3;

    const headers = {
      'content-type': 'text/plain; charset=utf-8',
      Title: alert.title,
      Priority: String(priority),
      Tags: alert.tags.join(','),
    };
    if (alert.url) headers.Click = alert.url;
    if (alert.url) headers.Actions = `view, Open listing, ${alert.url}, clear=true`;
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetchImpl(`${server.replace(/\/$/, '')}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers,
      body: alert.body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`ntfy HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  },
};
