import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { banner } from '../logger.js';

const run = promisify(execFile);

/**
 * Local attention-grabber: terminal bell plus the OS notifier when one exists.
 * A missing notifier is not an error — the banner and bell still land.
 */
export default {
  name: 'desktop',
  configured: (cfg) => cfg.desktop !== false,
  async send(cfg, alert) {
    banner([alert.title, ...alert.body.split('\n').slice(0, 4), alert.url ?? ''].filter(Boolean));
    if (alert.urgency === 'max' || alert.urgency === 'high') process.stdout.write('\u0007\u0007\u0007');

    try {
      if (process.platform === 'darwin') {
        const script = `display notification ${q(alert.body)} with title ${q(alert.title)} sound name "Glass"`;
        await run('osascript', ['-e', script], { timeout: 5000 });
      } else if (process.platform === 'linux') {
        const urgency = alert.urgency === 'max' ? 'critical' : 'normal';
        await run('notify-send', ['-u', urgency, alert.title, alert.body], { timeout: 5000 });
      } else if (process.platform === 'win32') {
        await run(
          'powershell',
          ['-NoProfile', '-Command', `[console]::beep(880,400); Write-Host ${q(alert.title)}`],
          { timeout: 5000 },
        );
      }
    } catch {
      // No desktop session (a server, a container, no notify-send installed).
      // The banner above already delivered the message.
    }
  },
};

const q = (s) => `"${String(s).replace(/["\\]/g, '\\$&').replace(/\n/g, ' ')}"`;
