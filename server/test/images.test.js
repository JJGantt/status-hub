'use strict';
// /img/:name proxies the shared-images bucket; the name is the only input, so it is the whole check.
const test = require('node:test');
const assert = require('node:assert');
const { imgName } = require('../routes/images');

test('an image name is a flat uuid-like name with an image extension', () => {
  for (const ok of ['c6705114-9556-40e4-83b6-a7200b11a489.jpg', 'a.PNG', 'x_1.webp', 'y.gif', 'z.jpeg']) assert.ok(imgName(ok), ok);
  for (const bad of ['../api.jpg', 'a/b.jpg', 'a.svg', 'a.html', 'a.jpg.html', '.jpg', 'a', '']) assert.ok(!imgName(bad), bad);
});
