try {
  const [app, provider] = await Promise.all([
    fetch('http://127.0.0.1:8083/api/session', { signal: AbortSignal.timeout(2500) }),
    fetch('http://127.0.0.1:8082/health', { signal: AbortSignal.timeout(2500) })
  ]);
  process.exitCode = [200, 401].includes(app.status) && provider.status === 200 ? 0 : 1;
} catch { process.exitCode = 1; }
