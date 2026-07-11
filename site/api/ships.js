const { searchShips, searchShipsNear } = require('../lib/ships');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const query = req.query || {};
  const q = (query.q || '').trim();
  const lat = parseFloat(query.lat), lon = parseFloat(query.lon);
  if (q.length < 2) return res.end(JSON.stringify({ ships: [] }));
  try {
    const ships = Number.isFinite(lat) && Number.isFinite(lon)
      ? await searchShipsNear(q, lat, lon)
      : await searchShips(q);
    res.end(JSON.stringify({ ships }));
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: e.message || 'Ship search failed' }));
  }
};
