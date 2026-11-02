// The card drawing worker (see cards.js): gets { id, tree, width, outWidth },
// answers { id, png } or { id, error }. Cards are drawn one at a time.
const { parentPort } = require('worker_threads');
const { draw } = require('./cards-draw');

let queue = Promise.resolve();
parentPort.on('message', ({ id, tree, width, outWidth }) => {
  queue = queue.then(async () => {
    try {
      const png = await draw(tree, width, outWidth);
      parentPort.postMessage({ id, png }); // copied: resvg's buffer can't be transferred
    } catch (err) {
      parentPort.postMessage({ id, error: err && err.message ? err.message : String(err) });
    }
  });
});
