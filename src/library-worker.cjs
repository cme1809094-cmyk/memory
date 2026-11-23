const { parentPort, workerData } = require('node:worker_threads');
const { copyLibrary, validateLibrary } = require('./store.cjs');

try {
  const { operation, source, target } = workerData;
  if (operation === 'copy') copyLibrary(source, target);
  else validateLibrary(source);
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
