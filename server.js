const express = require('express');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const cors = require('cors');
const AdmZip = require('adm-zip');
const compression = require('compression');

// Use native fetch (built into Node 18+) with fallback to node-fetch if needed
const fetchFn = (typeof globalThis.fetch === 'function') 
    ? globalThis.fetch 
    : (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const port = process.env.PORT || 3000;

// Data Feed URLs
const GTFS_REALTIME_URL = 'https://bustime.ttc.ca/gtfsrt/vehicles';
const GTFS_STATIC_URL = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/7795b45e-e65a-4465-81fc-c36b9dfff169/resource/cfb6b2b8-6191-41e3-bda1-b175c51148cb/download/TTC%20Routes%20and%20Schedules%20Data.zip';

const METROLINX_REALTIME_URL = process.env.METROLINX_REALTIME_URL || 'https://api.openmetrolinx.com/OpenDataAPI/api/v1/Gtfs/Feed/VehiclePosition';
const METROLINX_API_KEY = process.env.METROLINX_API_KEY || '';

// Enable Gzip/Brotli response compression for ultra-fast network transfers
app.use(compression());
app.use(cors());

// --- GLOBAL CACHE ---
let cache = {
    buses: [],          // Combined real-time vehicle locations
    routes: {},         // Static route details
    staleCount: 0,      // Tracks data freshness
    lastDataString: ""  // Hash comparison for cache updates
};

// Default route color schemes
const DEFAULT_ROUTE_COLORS = {
    // TTC Subway Lines
    "1": { color: "FFC72C", textColor: "000000", type: "1", agency: "ttc" }, // Line 1 Yonge-University
    "2": { color: "008000", textColor: "FFFFFF", type: "1", agency: "ttc" }, // Line 2 Bloor-Danforth (#008000)
    "4": { color: "B30086", textColor: "FFFFFF", type: "1", agency: "ttc" }, // Line 4 Sheppard
    "5": { color: "ff8000", textColor: "FFFFFF", type: "1", agency: "ttc" }, // Line 5 Eglinton LRT (#ff8000)
    "6": { color: "808080", textColor: "FFFFFF", type: "1", agency: "ttc" }, // Line 6 Finch West LRT (#808080)

    // GO Transit Train Corridors
    "LW": { color: "00853D", textColor: "FFFFFF", type: "2", agency: "go" },
    "LE": { color: "FFC72C", textColor: "000000", type: "2", agency: "go" },
    "MI": { color: "E75D2A", textColor: "FFFFFF", type: "2", agency: "go" },
    "KI": { color: "00A3E0", textColor: "FFFFFF", type: "2", agency: "go" },
    "BR": { color: "005DAA", textColor: "FFFFFF", type: "2", agency: "go" },
    "ST": { color: "790022", textColor: "FFFFFF", type: "2", agency: "go" },
    "RH": { color: "009639", textColor: "FFFFFF", type: "2", agency: "go" },

    // UP Express
    "UP": { color: "004B49", textColor: "D4AF37", type: "2", agency: "up" }
};

// Enums
const OCCUPANCY_MAP = {
    0: 'EMPTY',
    1: 'MANY_SEATS_AVAILABLE',
    2: 'FEW_SEATS_AVAILABLE',
    3: 'STANDING_ROOM_ONLY',
    4: 'CRUSHED_STANDING_ROOM_ONLY',
    5: 'FULL',
    6: 'NOT_ACCEPTING_PASSENGERS'
};

const STATUS_MAP = {
    0: 'INCOMING_AT',
    1: 'STOPPED_AT',
    2: 'IN_TRANSIT_TO'
};

function formatEnum(val, mapObj) {
    if (val === null || val === undefined) return null;
    if (typeof val === 'number' && mapObj[val]) return mapObj[val];
    return String(val);
}

function isValidGtaLocation(lat, lng) {
    if (typeof lat !== 'number' || typeof lng !== 'number' || isNaN(lat) || isNaN(lng)) return false;
    if (lat < 43.15 || lat > 44.80 || lng < -80.60 || lng > -78.30) return false;
    if (lat < 43.60 && lng > -79.48 && lng < -78.95) return false;
    return true;
}

function getRouteColor(routeId, rawGtfsColor = "", rawGtfsTextColor = "") {
    const rId = String(routeId).trim();

    if (DEFAULT_ROUTE_COLORS[rId]) {
        return {
            color: `#${DEFAULT_ROUTE_COLORS[rId].color}`,
            textColor: `#${DEFAULT_ROUTE_COLORS[rId].textColor}`
        };
    }

    if (rawGtfsColor && rawGtfsColor !== 'DA291C' && rawGtfsColor !== '#DA291C' && rawGtfsColor !== '#da291c') {
        const c = rawGtfsColor.startsWith('#') ? rawGtfsColor : `#${rawGtfsColor}`;
        const tc = rawGtfsTextColor ? (rawGtfsTextColor.startsWith('#') ? rawGtfsTextColor : `#${rawGtfsTextColor}`) : '#FFFFFF';
        return { color: c, textColor: tc };
    }

    const num = parseInt(rId.replace(/\D/g, '')) || 0;

    if (num >= 200 && num <= 299) {
        return { color: '#CB6599', textColor: '#FFFFFF' };
    }

    if (num >= 900 && num <= 999) {
        return { color: '#008000', textColor: '#FFFFFF' };
    }

    if (num >= 300 && num <= 399) {
        return { color: '#0080C0', textColor: '#FFFFFF' };
    }

    return { color: '#DA291C', textColor: '#FFFFFF' };
}

// --- WORKER 1: STATIC DATA ---
async function updateStaticData() {
    try {
        console.log("[Static Worker] Downloading Static TTC GTFS Data (routes.txt)...");
        const response = await fetchFn(GTFS_STATIC_URL, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GTA-Tracker-Backend/2.0' }
        });
        if (!response.ok) throw new Error(`Failed to download static zip: ${response.statusText}`);

        const buffer = await response.arrayBuffer();
        const zip = new AdmZip(Buffer.from(buffer));
        const routeText = zip.readAsText("routes.txt");

        const lines = routeText.split('\n');
        if (lines.length < 2) return;

        const headers = lines[0].split(',').map(h => h.trim().replace(/^[\ufeff]+/, '').replace(/['"]+/g, ''));
        
        const idIndex = headers.indexOf('route_id');
        const shortNameIndex = headers.indexOf('route_short_name');
        const longNameIndex = headers.indexOf('route_long_name');
        const typeIndex = headers.indexOf('route_type');
        const colorIndex = headers.indexOf('route_color');
        const textColorIndex = headers.indexOf('route_text_color');

        let newRoutes = {};

        // Preload default GO & UP Express routes
        Object.keys(DEFAULT_ROUTE_COLORS).forEach(rId => {
            const def = DEFAULT_ROUTE_COLORS[rId];
            newRoutes[rId] = {
                id: rId,
                shortName: rId,
                longName: rId === 'UP' ? 'UP Express' : `${rId} GO Line`,
                type: def.type,
                agency: def.agency,
                color: `#${def.color}`,
                textColor: `#${def.textColor}`
            };
        });

        for (let i = 1; i < lines.length; i++) {
            const currentLine = lines[i];
            if (!currentLine || currentLine.trim() === "") continue;

            const parts = currentLine.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            
            if (parts[idIndex] !== undefined) {
                const routeId = parts[idIndex].replace(/"/g, '').trim();
                const shortName = shortNameIndex !== -1 && parts[shortNameIndex] ? parts[shortNameIndex].replace(/"/g, '').trim() : routeId;
                const longName = longNameIndex !== -1 && parts[longNameIndex] ? parts[longNameIndex].replace(/"/g, '').trim() : shortName;
                const routeType = typeIndex !== -1 && parts[typeIndex] ? parts[typeIndex].replace(/"/g, '').trim() : "3";
                
                let routeColor = colorIndex !== -1 && parts[colorIndex] ? parts[colorIndex].replace(/"/g, '').trim() : "";
                let routeTextColor = textColorIndex !== -1 && parts[textColorIndex] ? parts[textColorIndex].replace(/"/g, '').trim() : "";

                const computedColors = getRouteColor(shortName || routeId, routeColor, routeTextColor);

                const routeObj = {
                    id: routeId,
                    shortName: shortName,
                    longName: longName,
                    type: routeType,
                    agency: DEFAULT_ROUTE_COLORS[routeId] ? DEFAULT_ROUTE_COLORS[routeId].agency : "ttc",
                    color: computedColors.color,
                    textColor: computedColors.textColor
                };

                newRoutes[routeId] = routeObj;
                if (shortName && shortName !== routeId) {
                    newRoutes[shortName] = routeObj;
                }
            }
        }

        cache.routes = newRoutes;
        console.log(`[Static Worker] Successfully loaded ${Object.keys(newRoutes).length} GTA routes.`);

    } catch (error) {
        console.error("[Static Worker] Error loading static GTFS data:", error.message);
    }
}

// --- SUBWAY CORRIDORS ---
const TRANSIT_CORRIDORS = {
    "1": [
        [43.7798, -79.4158], [43.7679, -79.4128], [43.7615, -79.4109], [43.7441, -79.4068],
        [43.7303, -79.4057], [43.7250, -79.4021], [43.7061, -79.3987], [43.7001, -79.3986],
        [43.6865, -79.3906], [43.6774, -79.3888], [43.6702, -79.3868], [43.6648, -79.3842],
        [43.6599, -79.3831], [43.6563, -79.3810], [43.6525, -79.3793], [43.6491, -79.3777],
        [43.6454, -79.3806], [43.6477, -79.3849], [43.6508, -79.3867], [43.6551, -79.3884],
        [43.6595, -79.3904], [43.6672, -79.4038], [43.6702, -79.4111], [43.6854, -79.4312],
        [43.6987, -79.4358], [43.7250, -79.4524], [43.7497, -79.4619], [43.7512, -79.4752],
        [43.7524, -79.4878], [43.7538, -79.5002], [43.7551, -79.5135], [43.7564, -79.5268],
        [43.7578, -79.5398], [43.7591, -79.5524], [43.7605, -79.5651]
    ],
    "2": [
        [43.6375, -79.5356], [43.6453, -79.5244], [43.6482, -79.5113], [43.6498, -79.4944],
        [43.6517, -79.4757], [43.6538, -79.4668], [43.6569, -79.4528], [43.6602, -79.4357],
        [43.6641, -79.4184], [43.6672, -79.4038], [43.6702, -79.3868], [43.6737, -79.3687],
        [43.6767, -79.3584], [43.6798, -79.3450], [43.6843, -79.3232], [43.6890, -79.3017],
        [43.6948, -79.2887], [43.7114, -79.2794], [43.7323, -79.2637]
    ],
    "4": [
        [43.7615, -79.4109], [43.7669, -79.3867], [43.7692, -79.3763], [43.7713, -79.3653], [43.7754, -79.3464]
    ],
    "5": [
        [43.6888, -79.4862], [43.6898, -79.4712], [43.6912, -79.4588], [43.6932, -79.4485],
        [43.6958, -79.4382], [43.6982, -79.4358], [43.7005, -79.4182], [43.7028, -79.4085],
        [43.7042, -79.4012], [43.7061, -79.3987], [43.7082, -79.3888], [43.7105, -79.3775],
        [43.7128, -79.3652], [43.7152, -79.3528], [43.7188, -79.3382], [43.7212, -79.3288],
        [43.7235, -79.3182], [43.7258, -79.3085], [43.7275, -79.2982], [43.7288, -79.2882],
        [43.7298, -79.2782], [43.7305, -79.2682], [43.7312, -79.2582], [43.7318, -79.2482],
        [43.7323, -79.2637]
    ],
    "6": [
        [43.7652, -79.4912], [43.7635, -79.5028], [43.7618, -79.5135], [43.7602, -79.5228],
        [43.7585, -79.5322], [43.7568, -79.5428], [43.7552, -79.5535], [43.7535, -79.5642],
        [43.7518, -79.5748], [43.7502, -79.5852], [43.7485, -79.5958], [43.7442, -79.6008],
        [43.7388, -79.6035], [43.7335, -79.6048], [43.7288, -79.6062]
    ]
};

function getTorontoSecs() {
    try {
        const now = new Date();
        const torontoStr = now.toLocaleString("en-US", { timeZone: "America/Toronto" });
        const d = new Date(torontoStr);
        return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    } catch (e) {
        const now = new Date();
        return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    }
}

function generateAnticipatedSubways() {
    const vehicles = [];
    const nowSecs = getTorontoSecs();

    // 5:30 AM to 1:30 AM
    if (nowSecs >= 5400 && nowSecs < 19800) return vehicles;

    const SUBWAY_CONFIGS = [
        { routeId: "1", agency: "ttc", type: "subway", durationSecs: 4200, headwaySecs: 210, stations: TRANSIT_CORRIDORS["1"] },
        { routeId: "2", agency: "ttc", type: "subway", durationSecs: 3000, headwaySecs: 240, stations: TRANSIT_CORRIDORS["2"] },
        { routeId: "4", agency: "ttc", type: "subway", durationSecs: 600,  headwaySecs: 330, stations: TRANSIT_CORRIDORS["4"] },
        { routeId: "5", agency: "ttc", type: "subway", durationSecs: 2400, headwaySecs: 300, stations: TRANSIT_CORRIDORS["5"] },
        { routeId: "6", agency: "ttc", type: "subway", durationSecs: 2100, headwaySecs: 360, stations: TRANSIT_CORRIDORS["6"] }
    ];

    SUBWAY_CONFIGS.forEach(cfg => {
        const numVehicles = Math.floor(cfg.durationSecs / cfg.headwaySecs);
        const totalSegs = cfg.stations.length - 1;
        const segLength = 1 / totalSegs;

        [0, 1].forEach(direction => {
            const stations = direction === 0 ? cfg.stations : [...cfg.stations].reverse();

            for (let i = 0; i < numVehicles; i++) {
                const progress = ((nowSecs + i * cfg.headwaySecs) % cfg.durationSecs) / cfg.durationSecs;
                const index = Math.min(Math.floor(progress / segLength), totalSegs - 1);
                const segProgress = (progress - index * segLength) / segLength;
                
                const p1 = stations[index];
                const p2 = stations[index + 1];

                const lat = p1[0] + (p2[0] - p1[0]) * segProgress;
                const lng = p1[1] + (p2[1] - p1[1]) * segProgress;
                
                if (!isValidGtaLocation(lat, lng)) return;

                let bearing = Math.round((Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) * 180 / Math.PI + 360) % 360);

                vehicles.push({
                    id: `TTC-${cfg.routeId}-${direction}-${i}`,
                    agency: "ttc",
                    type: "subway",
                    routeId: cfg.routeId,
                    directionId: direction,
                    latitude: lat,
                    longitude: lng,
                    bearing: bearing,
                    speed: 12.5,
                    occupancyStatus: "FEW SEATS AVAILABLE",
                    currentStatus: "IN TRANSIT TO",
                    isAnticipated: true,
                    timestamp: Math.floor(Date.now() / 1000)
                });
            }
        });
    });

    return vehicles;
}

// Fetch Metrolinx GTFS-RT Protobuf Vehicles (When METROLINX_API_KEY is configured)
async function fetchMetrolinxVehicles() {
    if (!METROLINX_API_KEY) return [];
    try {
        const response = await fetchFn(`${METROLINX_REALTIME_URL}?key=${METROLINX_API_KEY}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GTA-Transit-Tracker/2.0' }
        });
        if (!response.ok) return [];

        const buffer = await response.arrayBuffer();
        const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

        return feed.entity.map(entity => {
            if (entity.vehicle && entity.vehicle.position) {
                const v = entity.vehicle;
                const vId = (v.vehicle && v.vehicle.id) ? v.vehicle.id : entity.id;
                const routeId = v.trip ? (v.trip.routeId || 'GO') : 'GO';
                const isUP = routeId.toUpperCase().includes('UP') || String(vId).startsWith('UP');
                const agency = isUP ? 'up' : 'go';
                const isTrain = isUP || ['LW','LE','MI','KI','BR','ST','RH','LKW','LKE'].some(r => routeId.toUpperCase().includes(r));

                if (!isValidGtaLocation(v.position.latitude, v.position.longitude)) return null;

                return {
                    id: `${agency.toUpperCase()}-${vId}`,
                    agency: agency,
                    type: isTrain ? 'train' : 'bus',
                    routeId: routeId,
                    directionId: v.trip ? v.trip.directionId : null,
                    latitude: v.position.latitude,
                    longitude: v.position.longitude,
                    bearing: v.position.bearing || 0,
                    speed: v.position.speed || 0,
                    occupancyStatus: formatEnum(v.occupancyStatus, OCCUPANCY_MAP),
                    currentStatus: formatEnum(v.currentStatus, STATUS_MAP),
                    stopId: v.stopId || null,
                    timestamp: v.timestamp ? Number(v.timestamp) : Math.floor(Date.now() / 1000)
                };
            }
            return null;
        }).filter(v => v !== null);

    } catch (error) {
        console.warn("[Metrolinx Worker] Realtime fetch warning:", error.message);
        return [];
    }
}

// --- WORKER 2: REAL-TIME DATA (Runs every 10 seconds) ---
async function updateRealtimeData() {
    try {
        // 1. Fetch TTC Real-Time Vehicles
        const response = await fetchFn(GTFS_REALTIME_URL, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GTA-Transit-Tracker/2.0' 
            }
        });

        if (!response.ok) throw new Error(`External TTC API Error: ${response.status}`);

        const buffer = await response.arrayBuffer();
        const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

        const STREETCAR_ROUTES = new Set(['501', '503', '504', '505', '506', '507', '509', '510', '511', '512', '301', '304', '306', '310']);

        const surfaceBuses = feed.entity.map(entity => {
            if (entity.vehicle && entity.vehicle.position) {
                const vehicleObj = entity.vehicle;
                const vehicleId = (vehicleObj.vehicle && vehicleObj.vehicle.id) ? vehicleObj.vehicle.id : entity.id;
                const routeId = vehicleObj.trip ? vehicleObj.trip.routeId : 'Unknown';
                const isStreetcar = STREETCAR_ROUTES.has(String(routeId));

                if (!isValidGtaLocation(vehicleObj.position.latitude, vehicleObj.position.longitude)) return null;

                const routeColors = (cache.routes && cache.routes[routeId]) ? cache.routes[routeId] : getRouteColor(routeId);

                return {
                    id: `TTC-${vehicleId}`,
                    agency: 'ttc',
                    type: isStreetcar ? 'streetcar' : 'bus',
                    routeId: routeId,
                    directionId: vehicleObj.trip ? vehicleObj.trip.directionId : null,
                    latitude: vehicleObj.position.latitude,
                    longitude: vehicleObj.position.longitude,
                    bearing: vehicleObj.position.bearing || 0,
                    speed: vehicleObj.position.speed || 0,
                    occupancyStatus: formatEnum(vehicleObj.occupancyStatus, OCCUPANCY_MAP),
                    currentStatus: formatEnum(vehicleObj.currentStatus, STATUS_MAP),
                    color: routeColors.color,
                    textColor: routeColors.textColor,
                    stopId: vehicleObj.stopId || null,
                    timestamp: vehicleObj.timestamp ? Number(vehicleObj.timestamp) : Math.floor(Date.now() / 1000)
                };
            }
            return null;
        }).filter(bus => bus !== null);

        // 2. Fetch Metrolinx (GO Transit & UP Express) live real-time vehicles (if API key is present)
        const metrolinxVehicles = await fetchMetrolinxVehicles();

        // 3. Generate Anticipated Subways
        const anticipatedSubways = generateAnticipatedSubways();

        // Combine active vehicles
        const buses = [...surfaceBuses, ...metrolinxVehicles, ...anticipatedSubways];

        const currentDataString = JSON.stringify(buses);
        if (currentDataString === cache.lastDataString) {
            cache.staleCount++;
        } else {
            cache.staleCount = 0;
        }

        if (buses.length > 0) {
            cache.buses = buses;
            cache.lastDataString = currentDataString;
        }

    } catch (error) {
        console.error("[Realtime Worker] Fetch failed:", error.stack || error.message);
        cache.staleCount++;
    }
}

// --- INITIALIZE & START TIMERS ---
updateRealtimeData();
setInterval(updateRealtimeData, 10000); // Poll every 10 seconds

setTimeout(() => {
    updateStaticData();
    setInterval(updateStaticData, 86400000); // Refresh static data every 24 hours
}, 2000);

// --- ENDPOINTS ---

// Health Check
app.get('/', (req, res) => {
    res.json({
        status: "online",
        service: "GTA Public Transportation Tracker Backend API",
        activeVehicles: cache.buses.length,
        loadedRoutes: Object.keys(cache.routes).length,
        staleCount: cache.staleCount
    });
});

// 1. Get Real-time GTA Vehicles
app.get('/buses', (req, res) => {
    res.set('X-Stale-Count', cache.staleCount);
    res.set('Cache-Control', 'public, max-age=3');
    res.json(cache.buses);
});

// 2. Get Static Route List
app.get('/routes', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(cache.routes);
});

app.listen(port, () => {
    console.log(`GTA Transit Tracker Backend running on port ${port}`);
});
