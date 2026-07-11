// Ship name search against VesselFinder's public vessel search page
// (www.vesselfinder.com/vessels?name=...). Names inside a port's own
// arrivals/in-port tables are paywalled, so search is global by name;
// the frontend also accepts a raw IMO/MMSI typed directly.

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

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

module.exports = { searchShips };
