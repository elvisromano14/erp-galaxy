// Healthcheck de los contenedores: node /healthcheck.js <url>  → sale con 0 si responde 2xx.
fetch(process.argv[2], { signal: AbortSignal.timeout(4000) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));
