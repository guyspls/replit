/** Email via Resend's HTTP API — no SMTP dependency, no mail server. */
export default {
  name: 'email',
  configured: (cfg) => Boolean(cfg.email?.apiKey && cfg.email?.to),
  async send(cfg, alert, fetchImpl = fetch) {
    const { apiKey, to, from = 'scalper-bot <onboarding@resend.dev>' } = cfg.email;
    const html = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px">
        <h2 style="margin:0 0 8px">${escapeHtml(alert.title)}</h2>
        <p style="white-space:pre-wrap;margin:0 0 16px;color:#334155">${escapeHtml(alert.body)}</p>
        ${
          alert.url
            ? `<p><a href="${escapeHtml(alert.url)}" style="background:#16a34a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Open listing</a></p>`
            : ''
        }
      </div>`;
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        from,
        to: Array.isArray(to) ? to : [to],
        subject: alert.title,
        html,
        text: `${alert.body}\n\n${alert.url ?? ''}`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`resend HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  },
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
