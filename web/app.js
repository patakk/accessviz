const canvas = document.getElementById('globe');
const ctx = canvas.getContext('2d');
const statsEl = document.getElementById('stats');
const filterEl = document.getElementById('filter');
const filterCountryEl = document.getElementById('filter-country');
const filterCityEl = document.getElementById('filter-city');
const filterDeviceEl = document.getElementById('filter-device');
const tableBody = document.querySelector('#hits-table tbody');
const projectionEl = document.getElementById('projection');
const timeStartEl = document.getElementById('time-start');
const timeEndEl = document.getElementById('time-end');
const timeStartLabelEl = document.getElementById('time-start-label');
const timeEndLabelEl = document.getElementById('time-end-label');
const timeMinLabelEl = document.getElementById('time-min-label');
const timeMaxLabelEl = document.getElementById('time-max-label');
const timeProgressEl = document.getElementById('time-progress');

const dpr = window.devicePixelRatio || 1;
const baseWidth = 900;
const baseHeightShort = 500;
const baseRatio = baseHeightShort / baseWidth;
let width = baseWidth;
let height = baseHeightShort;
let radius = Math.max(width, height) / 2 - 20;
let mode = 'wide'; // wide | square | tall
let projectionName = 'orthographic';
let allowRotation = true;
const projectionScale = {
  orthographic: 1,
  mercator: 0.55,
  vanDerGrinten: 0.55,
};
let zoom = 1;
let panX = 0;
let panY = 0;

let points = [];
let land = null;
let projection;
let geoPath;
let graticule;
let rotation = 0;
let countryCounts = new Map();
let dragging = false;
let lastPos = null;
let allHits = [];
let timeDomain = { min: null, max: null };
let generatedAt = '';
let currentFilters = {
  text: '',
  country: 'all',
  city: 'all',
  device: 'all',
  startTs: null,
  endTs: null,
}; 

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

const isMobile = () => window.innerWidth <= 800;

const formatTs = (ts) => {
  if (!ts || Number.isNaN(ts)) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
};

const antipode = ([longitude, latitude]) => [longitude + 180, -latitude];

function getSunPosition(now = new Date()) {
  const day = new Date(+now);
  day.setUTCHours(0, 0, 0, 0);
  const t = solar.century(now);
  const longitude = (day - now) / 864e5 * 360 - 180;
  return [longitude - solar.equationOfTime(t) / 4, solar.declination(t)];
}

function getNightPolygon() {
  const sun = getSunPosition();
  const night = d3.geoCircle()
    .radius(90)
    .center(antipode(sun))
    ();
  return night;
}

function aggregateIps(hits) {
  const map = new Map();
  for (const h of hits) {
    const entry = map.get(h.ip) || {
      ip: h.ip,
      count: 0,
      first_seen: h.ts,
      last_seen: h.ts,
      country: h.country,
      city: h.city,
      lat: h.lat,
      lon: h.lon,
      ua_type: h.ua_type,
    };
    entry.count += 1;
    entry.last_seen = h.ts;
    if (!entry.country && h.country) entry.country = h.country;
    if (!entry.city && h.city) entry.city = h.city;
    if ((entry.lat == null || entry.lon == null) && h.lat != null && h.lon != null) {
      entry.lat = h.lat;
      entry.lon = h.lon;
    }
    if (!entry.ua_type && h.ua_type) entry.ua_type = h.ua_type;
    map.set(h.ip, entry);
  }
  return Array.from(map.values());
}

function updateCountryCounts(ips) {
  countryCounts = new Map();
  if (!land) return;
  for (const f of land.features) countryCounts.set(f, 0);
  for (const ip of ips) {
    if (ip.lat == null || ip.lon == null) continue;
    const coord = [ip.lon, ip.lat];
    for (const f of land.features) {
      if (d3.geoContains(f, coord)) {
        countryCounts.set(f, (countryCounts.get(f) || 0) + 1);
        break;
      }
    }
  }
}

function resizeCanvas() {
  if (isMobile() && mode === 'wide') mode = 'square';
  const rect = canvas.getBoundingClientRect();
  if (mode === 'tall') {
    const side = (window.innerHeight || rect.width || baseWidth);
    width = side;
    height = side;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = side + 'px';
    canvas.style.height = side + 'px';
  } else {
    width = rect.width || baseWidth;
    height = mode === 'square' ? width : Math.max(320, width * baseRatio);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  const baseRad = Math.min(width, height) / 2 - 10;
  radius = baseRad;
  setupProjection();
  draw();
}

function setupProjection() {
  const common = {
    translate: [width / 2 + panX, height / 2 + panY],
    scale: radius,
  };
  const scaleFactor = projectionScale[projectionName] || 1;
  const scaled = common.scale * scaleFactor * zoom;
  if (projectionName === 'mercator') {
    projection = d3.geoMercator()
      .translate(common.translate)
      .scale(scaled);
    allowRotation = false;
  } else if (projectionName === 'vanDerGrinten') {
    projection = d3.geoVanDerGrinten()
      .translate(common.translate)
      .scale(scaled);
    allowRotation = false;
  } else {
    projection = d3.geoOrthographic()
      .translate(common.translate)
      .scale(scaled)
      .clipAngle(90);
    allowRotation = true;
  }
  geoPath = d3.geoPath(projection, ctx);
  graticule = d3.geoGraticule10();
}

function drawSphere() {
  ctx.beginPath();
  geoPath({ type: "Sphere" });
  ctx.fillStyle = "#0a0a0a";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawGraticule() {
  ctx.beginPath();
  geoPath(graticule);
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 0.5;
  ctx.stroke();
}

function drawLand() {
  if (!land) return;
  ctx.lineWidth = 0.6;
  for (const feature of land.features) {
    ctx.beginPath();
    geoPath(feature);
    const c = countryCounts.get(feature) || 0;
    const alpha = c > 0 ? Math.min(0.8, 0.2 + Math.log10(c + 1) * 0.6) : 0.2;
    ctx.fillStyle = `rgba(150,150,150,${alpha})`;
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.stroke();
  }
}

function drawNight() {
  const night = getNightPolygon();
  ctx.beginPath();
  geoPath(night);
  ctx.fillStyle = "rgba(5, 0, 0, 0.5)";
  ctx.fill();
}

function drawPoints() {
  if (!projection) return;
  for (const p of points) {
    if (p.lat == null || p.lon == null) continue;
    let coord;
    if (projectionName === 'orthographic') {
      const rotator = d3.geoRotation(projection.rotate());
      const rotated = rotator([p.lon, p.lat]);
      if (!rotated || Math.abs(rotated[0]) > 90) continue; // skip points on the far side
      coord = projection([p.lon, p.lat]);
    } else {
      coord = projection([p.lon, p.lat]);
    }
    if (!coord) continue;
    const [x, y] = coord;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const size = 1 + Math.min(p.count || 1, 10) * 0.1;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
      ctx.fill();
    }
  }
}

function draw() {
  if (!projection) return;
  ctx.clearRect(0, 0, width, height);
  if (allowRotation) {
    projection.rotate([rotation, -15]);
  } else {
    projection.rotate([0, 0]);
  }
  drawSphere();
  drawLand();
  drawNight();
  drawGraticule();
  drawPoints();
}

function animate() {
  if (!dragging && allowRotation) {
    rotation += 0.05;
    if (rotation >= 180) rotation -= 360;
  }
  draw();
  requestAnimationFrame(animate);
}

function renderStats(totalHits, uniqueIps) {
  statsEl.innerHTML = `
    <div><strong>${totalHits}</strong> hits &nbsp;|&nbsp; <strong>${uniqueIps}</strong> unique IPs</div>
    <div>Generated: ${generatedAt}</div>
  `;
}

function countryCodeToFlag(code) {
  if (!code || code.length !== 2) return '';
  const base = 127397;
  return code.toUpperCase().split('').map(c => String.fromCodePoint(base + c.charCodeAt(0))).join('');
}

function renderCountry(code) {
  if (!code) return '';
  const flag = countryCodeToFlag(code);
  const label = code.toUpperCase();
  return flag ? `<span class="flag">${flag}</span><span>${label}</span>` : label;
}

function hitMatchesFilters(h, filters = currentFilters, textHay = null) {
  const q = (filters.text || '').trim().toLowerCase();
  const hay = textHay || `${h.ip} ${h.country || ''} ${h.city || ''} ${h.ua_type || ''} ${h.path || ''} ${h.request || ''}`.toLowerCase();
  if (q && !hay.includes(q)) return false;
  if (filters.country !== 'all' && (h.country || '').toLowerCase() !== filters.country.toLowerCase()) return false;
  if (filters.city !== 'all' && (h.city || '').toLowerCase() !== filters.city.toLowerCase()) return false;
  if (filters.device !== 'all' && (h.ua_type || '').toLowerCase() !== filters.device.toLowerCase()) return false;
  if (filters.startTs !== null && h._ts && h._ts < filters.startTs) return false;
  if (filters.endTs !== null && h._ts && h._ts > filters.endTs) return false;
  return true;
}

function populateFilters(hits) {
  const countries = new Map();
  const cities = new Map();
  const devices = new Map();
  const addVal = (map, val) => {
    if (!val) return;
    const key = val.toLowerCase();
    if (!map.has(key)) map.set(key, val);
  };
  for (const h of hits) {
    addVal(countries, h.country);
    addVal(cities, h.city);
    addVal(devices, h.ua_type);
  }
  const addOptions = (el, values) => {
    const current = el.value;
    const opts = ['all', ...Array.from(values.keys()).sort()];
    el.innerHTML = opts.map(v => {
      const label = v === 'all' ? `All ${el.dataset.label}` : values.get(v) || v;
      return `<option value="${v}">${label}</option>`;
    }).join('');
    if (opts.includes(current)) el.value = current;
  };
  filterCountryEl.dataset.label = 'countries';
  filterCityEl.dataset.label = 'cities';
  filterDeviceEl.dataset.label = 'devices';
  addOptions(filterCountryEl, countries);
  addOptions(filterCityEl, cities);
  addOptions(filterDeviceEl, devices);
}

function renderTable(hits, summaryList = points, filters = currentFilters) {
  const hitsByIp = {};
  for (const h of hits) {
    (hitsByIp[h.ip] = hitsByIp[h.ip] || []).push(h);
  }
  const rows = [];
  const summary = summaryList.map(p => ({
    ip: p.ip,
    country: p.country || '',
    city: p.city || '',
    ua_type: p.ua_type || '',
    count: p.count || 0,
  })).sort((a,b) => b.count - a.count);

  for (const s of summary) {
    const hlist = hitsByIp[s.ip] || [];
    const filteredDetails = hlist.filter((h) => hitMatchesFilters(h, filters));
    if (filteredDetails.length === 0) continue;
    const uaLabel = filteredDetails[0]?.ua_type || s.ua_type || '';
    rows.push(`
      <tr class="summary" data-ip="${s.ip}">
        <td>${s.ip}</td>
        <td class="country-cell">${renderCountry(s.country)}</td>
        <td>${s.city}</td>
        <td>${uaLabel}</td>
        <td colspan="2">${filteredDetails.length} hits</td>
        <td class="col-when">&#9660;</td>
      </tr>
    `);
    for (const h of filteredDetails) {
      const path = h.path || h.request || '';
      rows.push(`
        <tr class="detail" data-ip="${s.ip}" style="display:none;">
          <td>${h.ip}</td>
          <td class="country-cell">${renderCountry(h.country)}</td>
          <td>${h.city || ''}</td>
          <td>${h.ua_type || ''}</td>
          <td class="path-cell" title="${path}">${path}</td>
          <td><span class="pill">${h.status}</span></td>
          <td class="col-when">${h.ts}</td>
        </tr>
      `);
    }
  }
  tableBody.innerHTML = rows.join('') || '<tr><td colspan="7">No matches</td></tr>';
  tableBody.querySelectorAll('tr.summary').forEach(tr => {
    tr.addEventListener('click', () => {
      const ip = tr.getAttribute('data-ip');
      const open = tr.classList.toggle('open');
      tableBody.querySelectorAll(`tr.detail[data-ip="${ip}"]`).forEach(d => {
        d.style.display = open ? '' : 'none';
      });
      tr.lastElementChild.innerHTML = open ? '&#9650;' : '&#9660;';
    });
  });
}

function applyFilters() {
  const filteredHits = allHits.filter((h) => hitMatchesFilters(h, currentFilters));
  const ipSummary = aggregateIps(filteredHits);
  points = ipSummary.filter(p => p.lat !== null && p.lat !== undefined && p.lon !== null && p.lon !== undefined);
  renderTable(filteredHits, ipSummary, currentFilters);
  renderStats(filteredHits.length, ipSummary.length);
  updateCountryCounts(ipSummary);
  draw();
}

function updateTimelineProgress() {
  if (!timeDomain.min || !timeDomain.max) return;
  const span = timeDomain.max - timeDomain.min || 1;
  const startPct = clamp(((currentFilters.startTs ?? timeDomain.min) - timeDomain.min) / span, 0, 1) * 100;
  const endPct = clamp(((currentFilters.endTs ?? timeDomain.max) - timeDomain.min) / span, 0, 1) * 100;
  const left = Math.min(startPct, endPct);
  const width = Math.max(0, Math.abs(endPct - startPct));
  timeProgressEl.style.left = `${left}%`;
  timeProgressEl.style.width = `${width}%`;
}

function enableDrag() {
  let dragMode = 'rotate';
  const onDown = (e) => {
    dragMode = (!allowRotation) ? 'pan' : (e.shiftKey ? 'pan' : 'rotate');
    dragging = true;
    lastPos = [e.clientX || e.touches?.[0]?.clientX, e.clientY || e.touches?.[0]?.clientY];
  };
  const onMove = (e) => {
    if (!dragging) return;
    const x = e.clientX || e.touches?.[0]?.clientX;
    const y = e.clientY || e.touches?.[0]?.clientY;
    if (!lastPos || x == null || y == null) return;
    const dx = x - lastPos[0];
    const dy = y - lastPos[1];
    if (allowRotation && dragMode === 'rotate') {
      rotation += dx * 0.3;
    } else {
      panX += dx;
      panY += dy;
      setupProjection();
      draw();
    }
    lastPos = [x, y];
  };
  const onUp = () => { dragging = false; };
  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('touchstart', onDown);
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('touchmove', onMove);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('touchend', onUp);
}

function enableZoom() {
  const onWheel = (e) => {
    e.preventDefault();
    const delta = e.deltaY;
    const factor = delta > 0 ? 0.9 : 1.1;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const centerX = width / 2 + panX;
    const centerY = height / 2 + panY;
    const dx = cx - centerX;
    const dy = cy - centerY;
    const prevZoom = zoom;
    const nextZoom = clamp(zoom * factor, 0.5, 6);
    const scaleChange = nextZoom / prevZoom;
    panX -= dx * (scaleChange - 1);
    panY -= dy * (scaleChange - 1);
    zoom = nextZoom;
    setupProjection();
    draw();
  };
  canvas.addEventListener('wheel', onWheel, { passive: false });
}

async function load() {
  mode = isMobile() ? 'square' : 'wide';
  await resizeCanvas();
  const world = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json').then(r => r.json());
  land = topojson.feature(world, world.objects.countries);

  const res = await fetch('data.json?ts=' + Date.now());
  const data = await res.json();
  generatedAt = data.generated_at;
  allHits = (data.hits || []).map(h => ({ ...h, _ts: Date.parse(h.ts) }));
  if (allHits.length > 0) {
    timeDomain.min = Math.min(...allHits.map(h => h._ts || Date.now()));
    timeDomain.max = Math.max(...allHits.map(h => h._ts || Date.now()));
  } else {
    const nowTs = Date.now();
    timeDomain.min = nowTs;
    timeDomain.max = nowTs;
  }
  currentFilters.startTs = timeDomain.min;
  currentFilters.endTs = timeDomain.max;
  timeStartEl.min = timeDomain.min;
  timeStartEl.max = timeDomain.max;
  timeEndEl.min = timeDomain.min;
  timeEndEl.max = timeDomain.max;
  timeStartEl.value = timeDomain.min;
  timeEndEl.value = timeDomain.max;
  timeMinLabelEl.textContent = formatTs(timeDomain.min);
  timeMaxLabelEl.textContent = formatTs(timeDomain.max);
  timeStartLabelEl.textContent = formatTs(currentFilters.startTs);
  timeEndLabelEl.textContent = formatTs(currentFilters.endTs);
  populateFilters(allHits);
  updateTimelineProgress();
  applyFilters();
  filterEl.addEventListener('input', (e) => {
    currentFilters.text = e.target.value;
    applyFilters();
  });
  filterCountryEl.addEventListener('change', (e) => {
    currentFilters.country = e.target.value;
    applyFilters();
  });
  filterCityEl.addEventListener('change', (e) => {
    currentFilters.city = e.target.value;
    applyFilters();
  });
  filterDeviceEl.addEventListener('change', (e) => {
    currentFilters.device = e.target.value;
    applyFilters();
  });
  projectionEl.addEventListener('change', (e) => {
    projectionName = e.target.value;
    rotation = 0;
    zoom = 1;
    panX = 0;
    panY = 0;
    setupProjection();
    draw();
  });
  const updateTimeFromInputs = (apply = false) => {
    let startVal = Number(timeStartEl.value);
    let endVal = Number(timeEndEl.value);
    if (Number.isNaN(startVal)) startVal = timeDomain.min;
    if (Number.isNaN(endVal)) endVal = timeDomain.max;
    if (startVal > endVal) {
      [startVal, endVal] = [endVal, startVal];
    }
    currentFilters.startTs = startVal;
    currentFilters.endTs = endVal;
    timeStartEl.value = startVal;
    timeEndEl.value = endVal;
    timeStartLabelEl.textContent = formatTs(startVal);
    timeEndLabelEl.textContent = formatTs(endVal);
    updateTimelineProgress();
    if (apply) applyFilters();
  };
  timeStartEl.addEventListener('input', () => updateTimeFromInputs(false));
  timeEndEl.addEventListener('input', () => updateTimeFromInputs(false));
  timeStartEl.addEventListener('change', () => updateTimeFromInputs(true));
  timeEndEl.addEventListener('change', () => updateTimeFromInputs(true));
}

load().then(() => {
  const togglePage = document.querySelector('.page');
  document.getElementById('size-toggle').addEventListener('click', () => {
    if (isMobile()) {
      mode = mode === 'tall' ? 'square' : 'tall';
      togglePage.classList.toggle('tall-mode', mode === 'tall');
    } else {
      mode = mode === 'wide' ? 'square' : 'wide';
    }
    document.querySelector('.globe-wrap').classList.toggle('square', mode !== 'wide');
    resizeCanvas();
  });
  window.addEventListener('resize', () => {
    if (isMobile() && mode === 'wide') mode = 'square';
    if (!isMobile()) document.querySelector('.page').classList.remove('tall-mode');
    resizeCanvas();
  });
  enableDrag();
  enableZoom();
  animate();
}).catch(err => {
  console.error(err);
  tableBody.innerHTML = '<tr><td colspan="7">Failed to load data.json</td></tr>';
});
