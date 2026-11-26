'use strict';
// Every WebSocket endpoint on the hub, behind ONE `upgrade` listener. Node hands each upgrade to every
// listener, so a second `server.on('upgrade')` would answer requests meant for the first, and a
// listener that refuses what is not its own refuses everyone else's too. An upgrade never reaches
// Express's middleware, so each handler checks its own auth.
//
//   register(prefix, handler)   handler(req, socket, head) for every upgrade whose path starts with prefix
//   attach(server)              once, after listen

const routes = [];

function register(prefix, handler) { routes.push({ prefix, handler }); }

function attach(server) {
  server.on('upgrade', (req, socket, head) => {
    const path = String(req.url || '').split('?')[0];
    const r = routes.find((x) => path.startsWith(x.prefix));
    if (!r) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    try { r.handler(req, socket, head); }
    catch (e) { console.error(`[upgrade] ${path}: ${e.message || e}`); socket.destroy(); }
  });
}

const refuse = (socket, code = 401, text = 'Unauthorized') => {
  socket.write(`HTTP/1.1 ${code} ${text}\r\n\r\n`);
  socket.destroy();
};

module.exports = { register, attach, refuse };
