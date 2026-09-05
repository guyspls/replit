/** Generic JSON webhook — the escape hatch for IFTTT, Home Assistant, Shortcuts. */
export default {
  name: 'webhook',
  configured: (cfg) => Boolean(cfg.webhook?.url),
  async send(cfg, alert, fetchImpl = fetch) {
    const { url, method = 'POST', headers = {} } = cfg.webhook;
    const res = await fetchImpl(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(alert),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`webhook HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  },
};
