import { setInterval, setTimeout } from 'node:timers';

// Reports readiness, then drains for longer than Nx's default kill grace period.
console.log(`probe process: ${String(process.pid)}`);
console.log('probe draining');
setInterval(() => {}, 1_000);
process.on('SIGTERM', () => {
  setTimeout(() => {
    process.exit(143);
  }, 8_000);
});
