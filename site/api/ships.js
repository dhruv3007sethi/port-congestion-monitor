const { searchShips } = require('../lib/ships');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const q = ((req.query && req.query.q) || '').trim();
  if (q.length < 2) return res.end(JSON.stringify({ ships: [] }));
  try {
    const ships = await searchShips(q);
    res.end(JSON.stringify({ ships }));
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: e.message || 'Ship search failed' }));
  }
};
