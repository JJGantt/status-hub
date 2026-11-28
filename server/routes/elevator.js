// The phone's elevator-unlock pane (public/cards/elevator.js, docs/DOOR.md): the latest stored rides.
// The live state comes from the app itself, not from here.
module.exports = function ({ gated, sb }) {
  gated.get('/api/elevator/rides', async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
    try {
      res.json({ rides: await sb(`elevator_rides?select=id,at,started_at,outcome,rise_m,ride_s,steps_in_ride,steps_after,unlock_ms,error&order=at.desc&limit=${limit}`) });
    } catch (e) {
      console.error('[elevator] reading rides failed:', e);
      res.status(502).json({ error: 'unreachable' });
    }
  });
};
