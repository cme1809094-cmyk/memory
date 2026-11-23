const fs = require('node:fs');
const path = require('node:path');
const { createWorker, OEM } = require('tesseract.js');

function unpack(file) {
  return file.replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2');
}

function createRecognizer(cachePath) {
  let worker;
  const recognize = async (image) => {
    try {
      if (!worker) {
        fs.mkdirSync(cachePath, { recursive: true });
        const scripts = unpack(path.dirname(require.resolve('tesseract.js/package.json')));
        const corePath = unpack(path.dirname(require.resolve('tesseract.js-core/package.json')));
        const langPath = path.join(cachePath, 'models');
        fs.mkdirSync(langPath, { recursive: true });
        for (const lang of ['eng', 'chi_sim']) {
          const root = path.dirname(require.resolve('@tesseract.js-data/' + lang + '/package.json'));
          fs.copyFileSync(path.join(root, '4.0.0_best_int', lang + '.traineddata.gz'),
            path.join(langPath, lang + '.traineddata.gz'));
        }
        worker = await createWorker(['eng', 'chi_sim'], OEM.LSTM_ONLY, {
          cachePath, langPath, corePath, gzip: true,
          workerPath: path.join(scripts, 'src', 'worker-script', 'node', 'index.js')
        });
      }
      const result = await worker.recognize(image);
      return result.data.text.trim();
    } catch (error) {
      if (worker) await worker.terminate();
      worker = undefined;
      throw error;
    }
  };
  recognize.close = async () => {
    if (worker) await worker.terminate();
    worker = undefined;
  };
  return recognize;
}

module.exports = { createRecognizer };
