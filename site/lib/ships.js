// Ship search against VesselFinder's public pages. Names inside a port's own
// arrivals/in-port tables are paywalled, so we search globally by name, then
// fetch each candidate's last known position (the details page embeds it in
// a #djson blob — rounded to whole degrees for anonymous users, which is
// plenty to decide "near this port" vs "another ocean") and keep only ships
// within PORT_RADIUS_KM of the requested port.

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// generous: whole-degree position rounding alone can be off by ~78 km
const PORT_RADIUS_KM = 250;
const MAX_POSITION_LOOKUPS = 6;

async function searchShips(query) {
  const url = 'https://www.vesselfinder.com/vessels?name=' + encodeURIComponent(query);
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`VesselFinder search ${res.status}`);
  const html = await res.text();

  const re = /<a class="ship-link" href="\/vessels\/details\/(\d+)">([\s\S]*?)<\/a>/g;
  const ships = [];
  let m;
  while ((m = re.exec(html)) && ships.length < 8) {
    const inner = m[2];
    const name = (inner.match(/class="slna"[^>]*>([^<]+)</) || inner.match(/alt="([^"]+)"/) || [])[1];
    const type = (inner.match(/class="slty"[^>]*>([^<]+)</) || [])[1];
    if (name) ships.push({ imo: m[1], name: name.trim().replace(/-/g, ' '), type: (type || '').trim() });
  }
  return ships;
}

async function fetchShipPosition(imo) {
  const res = await fetch(`https://www.vesselfinder.com/vessels/details/${imo}`, {
    headers: { 'User-Agent': BROWSER_UA }
  });
  if (!res.ok) throw new Error(`VesselFinder details ${res.status}`);
  const html = await res.text();
  const m = html.match(/id="djson" data-json='([^']+)'/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[1]); } catch (e) { return null; }
  if (!Number.isFinite(j.ship_lat) || !Number.isFinite(j.ship_lon)) return null;
  return {
    lat: j.ship_lat,
    lon: j.ship_lon,
    mmsi: j.mmsi,
    lastReport: j.lrpd ? String(j.lrpd).trim() : ''
  };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = x => x * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Name search restricted to ships whose last known position is within
// PORT_RADIUS_KM of (lat, lon). Sorted nearest-first.
async function searchShipsNear(query, lat, lon) {
  const ships = await searchShips(query);
  const withPos = await Promise.all(ships.slice(0, MAX_POSITION_LOOKUPS).map(async s => {
    const pos = await fetchShipPosition(s.imo).catch(() => null);
    if (!pos) return null;
    return { ...s, distanceKm: Math.round(haversineKm(lat, lon, pos.lat, pos.lon)), lastReport: pos.lastReport };
  }));
  return withPos
    .filter(s => s && s.distanceKm <= PORT_RADIUS_KM)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

module.exports = { searchShips, searchShipsNear, PORT_RADIUS_KM };
