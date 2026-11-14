// main.ts — the entrypoint and lifecycle: bind an ephemeral port, register it with
// the env at $MAKEFUN_ENV_URL, serve until the env's /done says true, then exit 0.
// With no MAKEFUN_ENV_URL it serves standalone (for local testing) until SIGTERM.

import { createApp } from './app.ts';
import { Store } from './store.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<number> {
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const store = new Store();
  const server = createApp(store, { expectedToken: token });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the server bound to no TCP address'));
        return;
      }
      resolve(address.port);
    });
  });
  console.error(`[forge] listening on port ${port}`);

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    server.close(() => undefined);
    server.closeAllConnections();
  };
  process.on('SIGTERM', () => {
    stop();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    stop();
    process.exit(0);
  });

  if (envUrl === '') {
    console.error('[forge] MAKEFUN_ENV_URL is unset: serving standalone until SIGTERM');
    await new Promise<void>((resolve) => {
      process.on('SIGTERM', () => resolve());
      process.on('SIGINT', () => resolve());
    });
    stop();
    return 0;
  }

  // Register: POST {"port"} to $MAKEFUN_ENV_URL/register; the first register wins.
  let registered = false;
  let delayMs = 200;
  for (let attempt = 1; attempt <= 60 && !registered; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 200 || response.status === 201) {
        registered = true;
        console.error(`[forge] registered at ${envUrl} (port ${port})`);
      } else if (response.status === 409) {
        console.error('[forge] register conflict: another entry already registered');
        stop();
        return 1;
      } else {
        console.error(`[forge] register attempt ${attempt}: HTTP ${response.status}`);
      }
    } catch (e) {
      console.error(`[forge] register attempt ${attempt} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!registered) {
      await sleep(delayMs);
      delayMs = Math.min(2000, delayMs * 2);
    }
  }
  if (!registered) {
    console.error('[forge] could not register with the env');
    stop();
    return 1;
  }

  // Poll /done until the suite is over.
  let pollDelayMs = 500;
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) {
          console.error('[forge] the env is done; exiting 0');
          stop();
          return 0;
        }
        pollDelayMs = 500;
      }
    } catch (e) {
      console.error(`[forge] /done poll failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(pollDelayMs);
    pollDelayMs = Math.min(2000, pollDelayMs * 2);
  }
}

process.on('uncaughtException', (err: Error) => {
  console.error(`[forge] uncaught exception: ${err.stack ?? err.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason: unknown) => {
  console.error(`[forge] unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  process.exit(1);
});

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`[forge] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  },
);
