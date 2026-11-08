// Web-mercator math + a movable local origin so Three.js floats stay precise.
export const R = 6378137;
export const PI_R = Math.PI * R;

export function lonToMx(lon) { return R * lon * Math.PI / 180; }
export function latToMy(lat) { return R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)); }
export function mxToLon(mx) { return mx / R * 180 / Math.PI; }
export function myToLat(my) { return (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * 180 / Math.PI; }

// Local origin. k = cos(lat0) turns mercator meters into (approx) true meters.
export const origin = { mx: 0, my: 0, k: 1, lat: 0, lon: 0 };

export function setOrigin(lat, lon) {
  origin.lat = lat; origin.lon = lon;
  origin.mx = lonToMx(lon);
  origin.my = latToMy(lat);
  origin.k = Math.cos(lat * Math.PI / 180);
}

export function mercToWorld(mx, my) {
  return { x: (mx - origin.mx) * origin.k, z: -(my - origin.my) * origin.k };
}
export function worldToMerc(x, z) {
  return { mx: x / origin.k + origin.mx, my: -z / origin.k + origin.my };
}
export function worldToLatLon(x, z) {
  const m = worldToMerc(x, z);
  return { lat: myToLat(m.my), lon: mxToLon(m.mx) };
}

// Shift the origin so (dx, dz) in world space becomes the new (0, 0).
export function shiftOrigin(dx, dz) {
  origin.mx += dx / origin.k;
  origin.my -= dz / origin.k;
  origin.lon = mxToLon(origin.mx);
  origin.lat = myToLat(origin.my);
}

// Slippy tile helpers
export function tileMercSize(z) { return 2 * PI_R / (1 << z); }
export function tileAt(mx, my, z) {
  const ms = tileMercSize(z);
  return {
    x: Math.floor((mx + PI_R) / ms),
    y: Math.floor((PI_R - my) / ms),
  };
}
// NW corner of tile in mercator
export function tileCorner(z, x, y) {
  const ms = tileMercSize(z);
  return { mx: x * ms - PI_R, my: PI_R - y * ms };
}
