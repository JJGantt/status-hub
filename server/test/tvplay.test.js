'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { playLink } = require('../lib/tvplay');

const YT = 'com.google.android.youtube.tv';

test('a YouTube play links to the open that carried its video', () => {
  const cmd = { id: 'c1', args: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5', package: YT } };
  assert.deepStrictEqual(playLink(YT, cmd), { url: cmd.args.url, video_id: 'dQw4w9WgXcQ', command_id: 'c1' });
  const short = { id: 'c2', args: { url: 'https://youtu.be/dQw4w9WgXcQ' } };
  assert.strictEqual(playLink(YT, short).video_id, 'dQw4w9WgXcQ');
});

test('a YouTube play after a non-YouTube open is not linked', () => {
  const cmd = { id: 'c1', args: { url: 'intent://x#Intent;package=com.netflix.ninja;end' } };
  assert.deepStrictEqual(playLink(YT, cmd), { url: null, video_id: null, command_id: null });
});

test('another app links only when the open named its package', () => {
  const intent = { id: 'c3', args: { url: 'intent://title/123#Intent;package=com.amazon.amazonvideo.livingroom;end' } };
  assert.strictEqual(playLink('com.amazon.amazonvideo.livingroom', intent).command_id, 'c3');
  assert.strictEqual(playLink('com.netflix.ninja', intent).command_id, null);
  const bare = { id: 'c4', args: { url: 'https://example.com/show' } };
  assert.strictEqual(playLink('com.netflix.ninja', bare).command_id, null);
});

test('no open in the window means no link', () => {
  assert.strictEqual(playLink(YT, undefined).command_id, null);
  assert.strictEqual(playLink(YT, { id: 'c5', args: {} }).command_id, null);
});
