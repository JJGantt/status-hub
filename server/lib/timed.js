'use strict';
// How long a heavy read took, in the hub's log: `fly logs -a jared-status-hub | grep timing`.
function timed(handler) {
  return (req, res) => {
    const t0 = Date.now();
    res.on('finish', () => console.log(`[timing] ${req.path} ${Date.now() - t0}ms`));
    return handler(req, res);
  };
}

module.exports = { timed };
