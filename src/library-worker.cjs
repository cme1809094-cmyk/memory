const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { copyLibrary, validateLibrary, run } = require('./store.cjs');

async function perform() {
  const { operation, source, target, configFile, scope, paths, id } = workerData;
  if (operation === 'captureFiles') return require('./file-capture.cjs').captureFiles(configFile, scope, paths);
  if (operation === 'copy') return copyLibrary(source, target);
  if (operation === 'exportFile') {
    const { value } = run(configFile, 'file', { id, scope });
    const temporary = path.join(path.dirname(target), '.memory-' + randomUUID());
    try {
      fs.copyFileSync(value.path, temporary, fs.constants.COPYFILE_EXCL);
      fs.renameSync(temporary, target);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return;
  }
  return validateLibrary(source);
}

perform().then((value) => parentPort.postMessage({ value }),
  (error) => parentPort.postMessage({ error: error.message }));
