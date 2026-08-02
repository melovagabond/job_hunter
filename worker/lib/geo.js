// Geo checks, used only when the source API could not do the filtering
// for us. Prefer server side where/distance params (Adzuna, USAJobs).

const EARTH_RADIUS_MILES = 3958.8;

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(a));
}

// Returns one of: 'remote', 'in_radius', 'metro_keyword', 'out_of_area', 'unknown'
function classifyLocation(job, locationCfg) {
  if (job.is_remote) return 'remote';

  if (job.lat != null && job.lon != null) {
    const d = haversineMiles(
      locationCfg.home.lat, locationCfg.home.lon, job.lat, job.lon
    );
    return d <= locationCfg.radius_miles ? 'in_radius' : 'out_of_area';
  }

  const loc = (job.location || '').toLowerCase();
  if (!loc) return 'unknown';
  if (locationCfg.metro_keywords.some(k => loc.includes(k))) {
    return 'metro_keyword';
  }
  return 'out_of_area';
}

module.exports = { haversineMiles, classifyLocation };
