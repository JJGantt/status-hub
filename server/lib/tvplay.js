'use strict';
// Which `open` command a TV play followed (routes/tv.js /api/tv/play). A play is linked only when the
// command plausibly opened it: a YouTube url for a YouTube app, or an intent naming the play's package.
// A bare url for any other app is left unlinked rather than guessed, since the newest open in the window
// may have been for something that never played.
const YT_PKG = /youtube/;

function ytId(u) {
  return (String(u || '').match(/(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/)([\w-]{11})/) || [])[1] || null;
}

function playLink(pkg, cmd) {
  const none = { url: null, video_id: null, command_id: null };
  const url = cmd && cmd.args && cmd.args.url ? String(cmd.args.url) : null;
  if (!url) return none;
  if (YT_PKG.test(pkg)) {
    const id = ytId(url);
    return id ? { url, video_id: id, command_id: cmd.id } : none;
  }
  return url.includes(`package=${pkg}`) || (cmd.args.package === pkg) ? { url, video_id: null, command_id: cmd.id } : none;
}

module.exports = { playLink, ytId };
