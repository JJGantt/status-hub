'use strict';
// EVERY 5xx THE HUB ANSWERS IS AN ERROR, and reaches the ops responder as one. `reportFailures()` is
// mounted first in server.js; when a response finishes with a status of 500 or more it logs
// `[http] <METHOD> <path> answered <status>: <body>` with console.error, which lib/report.js sends on.
// It needs nothing from the handler, so a route that only answers 5xx is still reported.
//
// What a handler adds:
//   fail(res, err[, status, body])  answer a caught failure, and hand the hook `err`, so the report
//                                   carries its stack. The default body is { error: err.message }.
//   logged(res)                     the handler already logged this failure itself (console.error, or
//                                   console.warn below a threshold of its own): the hook adds nothing.
//   notAFailure(res)                a 5xx that is a protocol answer rather than a failure, such as a
//                                   Retry-After pacing reply. Rare, and each use says why.
// The query string is left out of the reported path: a kiosk URL can carry the device token in it.

function fail(res, err, status = 500, body) {
  res.locals.failure = err;
  if (body === undefined) body = { error: String((err && err.message) || err) };
  return typeof body === 'string' ? res.status(status).type('text').send(body) : res.status(status).json(body);
}

function logged(res) { res.locals.failureLogged = true; return res; }

function notAFailure(res) { res.locals.notAFailure = true; return res; }

function reportFailures() {
  return (req, res, next) => {
    let body = '';
    const send = res.send;
    res.send = function (b) {
      if (res.statusCode >= 500 && !body && b != null) {
        body = typeof b === 'string' || Buffer.isBuffer(b) ? String(b) : JSON.stringify(b);
      }
      return send.apply(this, arguments);
    };
    let done = false;
    const check = () => {
      if (done) return;
      done = true;
      if (res.statusCode < 500 || res.locals.failureLogged || res.locals.notAFailure) return;
      const where = String(req.originalUrl || req.url).split('?')[0];
      const line = `[http] ${req.method} ${where} answered ${res.statusCode}${body ? `: ${body.slice(0, 300)}` : ''}`;
      const err = res.locals.failure;
      if (err instanceof Error) console.error(line, err);
      else if (err != null) console.error(`${line} (${String(err).slice(0, 300)})`);
      else console.error(line);
    };
    res.on('finish', check);
    res.on('close', check);
    next();
  };
}

// The last error handler: a thrown 5xx is answered here and reported once, by the hook, with its stack.
// Anything else (a 4xx from a body parser) goes on to Express's own handler as before.
function errorHandler() {
  return (err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status < 500) return next(err);
    // Express's own handler logs it with console.error, so the hook stays out of the way.
    if (res.headersSent) { logged(res); return next(err); }
    fail(res, err, status, 'Internal Server Error');
  };
}

module.exports = { fail, logged, notAFailure, reportFailures, errorHandler };
