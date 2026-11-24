process.env.FAKE_MODE = 'fail';
await import('./fake-store.js');
