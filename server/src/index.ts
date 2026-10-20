import { buildApp } from './app.ts';
import { config } from './config.ts';

const { app, provider } = buildApp();

// Listen on loopback only — this app is never exposed to the network.
await app.listen({ host: config.host, port: config.port });

console.log(`ذاكِر: الخادم يعمل على http://${config.host}:${config.port} — افتح الواجهة على http://127.0.0.1:5173`);
const health = await provider.healthCheck();
console.log(health.code === 'ok' ? health.message : `تنبيه: ${health.message}${health.fix ? ` الحل: ${health.fix}` : ''}`);
