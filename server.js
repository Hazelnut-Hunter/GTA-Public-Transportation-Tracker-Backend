const express = require('express');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const cors = require('cors');
const AdmZip = require('adm-zip');

const compression = require('compression');

const app = express();
const port = process.env.PORT || 3000;

// Enable Gzip/Brotli response compression for ultra-fast network transfers
app.use(compression());
app.use(cors());

// --- GLOBAL CACHE ---
let cache = {
    buses: [],          // Real-time TTC vehicle locations
    routes: {},         // Static route info mapping routeId -> route details
    staleCount: 0,      // Tracks how many times real-time data was identical
    lastDataString: ""  // JSON string of vehicle data for comparison
};

// Default fallback route colors for subway & major lines if missing in routes.txt
const DEFAULT_ROUTE_COLORS = {
    "1": { color: "D5C82B", textColor: "000000", type: "1" }, // Line 1 Yonge-University (Yellow)
    "2": { color: "00994C", textColor: "FFFFFF", type: "1" }, // Line 2 Bloor-Danforth (Green)
    "3": { color: "0080C0", textColor: "FFFFFF", type: "1" }, // Line 3 Scarborough (Blue)
    "4": { color: "B30086", textColor: "FFFFFF", type: "1" }  // Line 4 Sheppard (Purple)
};

// --- WORKER 1: STATIC DATA (Runs on startup, refreshes every 24 hours) ---
async function updateStaticData() {
    try {
        console.log("[Static Worker] Downloading Static TTC GTFS Data (routes.txt)...");
        const response = await fetch(GTFS_STATIC_URL, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TTC-Tracker-Backend/1.0' }
        });
        if (!response.ok) throw new Error(`Failed to download static zip: ${response.statusText}`);

        const buffer = await response.arrayBuffer();
        const zip = new AdmZip(Buffer.from(buffer));
        const routeText = zip.readAsText("routes.txt");

        const lines = routeText.split('\n');
        if (lines.length < 2) return;

        // Parse headers cleanly (removing BOM and extra quotes)
        const headers = lines[0].split(',').map(h => h.trim().replace(/^[\ufeff]+/, '').replace(/['"]+/g, ''));
        
        const idIndex = headers.indexOf('route_id');
        const shortNameIndex = headers.indexOf('route_short_name');
        const longNameIndex = headers.indexOf('route_long_name');
        const typeIndex = headers.indexOf('route_type');
        const colorIndex = headers.indexOf('route_color');
        const textColorIndex = headers.indexOf('route_text_color');

        let newRoutes = {};

        for (let i = 1; i < lines.length; i++) {
            const currentLine = lines[i];
            if (!currentLine || currentLine.trim() === "") continue;

            // Regex split respecting quoted fields
            const parts = currentLine.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            
            if (parts[idIndex] !== undefined) {
                const routeId = parts[idIndex].replace(/"/g, '').trim();
                const shortName = shortNameIndex !== -1 && parts[shortNameIndex] ? parts[shortNameIndex].replace(/"/g, '').trim() : routeId;
                const longName = longNameIndex !== -1 && parts[longNameIndex] ? parts[longNameIndex].replace(/"/g, '').trim() : shortName;
                const routeType = typeIndex !== -1 && parts[typeIndex] ? parts[typeIndex].replace(/"/g, '').trim() : "3";
                
                let routeColor = colorIndex !== -1 && parts[colorIndex] ? parts[colorIndex].replace(/"/g, '').trim() : "";
                let routeTextColor = textColorIndex !== -1 && parts[textColorIndex] ? parts[textColorIndex].replace(/"/g, '').trim() : "";

                // Apply default color scheme if missing
                if (!routeColor && DEFAULT_ROUTE_COLORS[routeId]) {
                    routeColor = DEFAULT_ROUTE_COLORS[routeId].color;
                    routeTextColor = DEFAULT_ROUTE_COLORS[routeId].textColor;
                } else if (!routeColor) {
                    routeColor = routeType === "0" ? "DA291C" : (routeType === "1" ? "FFC72C" : "DA291C");
                    routeTextColor = "FFFFFF";
                }

                newRoutes[routeId] = {
                    id: routeId,
                    shortName: shortName,
                    longName: longName,
                    type: routeType, // 0 = Tram/Streetcar, 1 = Subway, 3 = Bus
                    color: routeColor.startsWith("#") ? routeColor : `#${routeColor}`,
                    textColor: routeTextColor.startsWith("#") ? routeTextColor : `#${routeTextColor}`
                };
            }
        }

        cache.routes = newRoutes;
        console.log(`[Static Worker] Successfully loaded ${Object.keys(newRoutes).length} TTC routes.`);

    } catch (error) {
        console.error("[Static Worker] Static Data Error:", error.message);
    }
}

const OCCUPANCY_MAP = {
    0: "EMPTY",
    1: "MANY SEATS AVAILABLE",
    2: "FEW SEATS AVAILABLE",
    3: "STANDING ROOM ONLY",
    4: "CRUSHED STANDING ROOM ONLY",
    5: "FULL",
    6: "NOT ACCEPTING PASSENGERS"
};

const STATUS_MAP = {
    0: "INCOMING AT",
    1: "STOPPED AT",
    2: "IN TRANSIT TO"
};

function formatEnum(val, mapObj) {
    if (val === null || val === undefined) return null;
    if (typeof val === 'number' && mapObj[val]) return mapObj[val];
    return String(val);
}

// --- SUBWAY & LRT LINE GEOMETRIES FOR ANTICIPATED LIVE TRACKING (LINES 1 - 6) ---
const SUBWAY_GEOMETRIES = {
    "1": [
        [43.7941, -79.5275], [43.7836, -79.5085], [43.7769, -79.5015], [43.7497, -79.4619],
        [43.7454, -79.4522], [43.7344, -79.4501], [43.7258, -79.4475], [43.7088, -79.4407],
        [43.6987, -79.4358], [43.6841, -79.4184], [43.6743, -79.4072], [43.6681, -79.4005],
        [43.6681, -79.3997], [43.6672, -79.3934], [43.6601, -79.3905], [43.6548, -79.3883],
        [43.6508, -79.3867], [43.6477, -79.3849], [43.6454, -79.3806], [43.6491, -79.3777],
        [43.6525, -79.3793], [43.6563, -79.3810], [43.6599, -79.3831], [43.6648, -79.3842],
        [43.6702, -79.3868], [43.6774, -79.3888], [43.6865, -79.3906], [43.7001, -79.3986],
        [43.7061, -79.3987], [43.7250, -79.4021], [43.7303, -79.4057], [43.7441, -79.4068],
        [43.7615, -79.4109], [43.7679, -79.4128], [43.7798, -79.4158]
    ],
    "2": [
        [43.6375, -79.5356], [43.6453, -79.5244], [43.6482, -79.5113], [43.6498, -79.4944],
        [43.6499, -79.4842], [43.6517, -79.4757], [43.6538, -79.4668], [43.6555, -79.4597],
        [43.6569, -79.4528], [43.6590, -79.4428], [43.6602, -79.4357], [43.6624, -79.4262],
        [43.6641, -79.4184], [43.6659, -79.4111], [43.6672, -79.4038], [43.6681, -79.3997],
        [43.6702, -79.3900], [43.6702, -79.3868], [43.6722, -79.3764], [43.6737, -79.3687],
        [43.6767, -79.3584], [43.6782, -79.3523], [43.6798, -79.3450], [43.6811, -79.3378],
        [43.6826, -79.3303], [43.6843, -79.3232], [43.6865, -79.3129], [43.6890, -79.3017],
        [43.6948, -79.2887], [43.7114, -79.2794], [43.7323, -79.2637]
    ],
    "4": [
        [43.7615, -79.4109], [43.7669, -79.3867], [43.7692, -79.3763], [43.7713, -79.3653], [43.7754, -79.3464]
    ],
    "5": [
        [43.6876, -79.4862], [43.6899, -79.4751], [43.6922, -79.4654], [43.6945, -79.4552],
        [43.6971, -79.4449], [43.6987, -79.4358], [43.7011, -79.4261], [43.7032, -79.4168],
        [43.7047, -79.4082], [43.7061, -79.3987], [43.7088, -79.3888], [43.7114, -79.3789],
        [43.7139, -79.3689], [43.7169, -79.3582], [43.7214, -79.3402], [43.7248, -79.3288],
        [43.7265, -79.3175], [43.7281, -79.3061], [43.7299, -79.2934], [43.7323, -79.2637]
    ],
    "6": [
        [43.7497, -79.4619], [43.7512, -79.4752], [43.7524, -79.4878], [43.7538, -79.5002],
        [43.7551, -79.5135], [43.7564, -79.5268], [43.7578, -79.5398], [43.7591, -79.5524],
        [43.7605, -79.5651], [43.7584, -79.5782], [43.7532, -79.5876], [43.7468, -79.5934],
        [43.7412, -79.5978], [43.7356, -79.6012]
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
    const subways = [];
    const nowSecs = getTorontoSecs();
    
    // Operating hours 5:30 AM (19800s) to 1:30 AM next day (5400s Toronto time)
    if (nowSecs >= 5400 && nowSecs < 19800) return subways;

    const SUBWAY_CONFIGS = [
        { routeId: "1", durationSecs: 4200, headwaySecs: 210, stations: SUBWAY_GEOMETRIES["1"] },
        { routeId: "2", durationSecs: 3000, headwaySecs: 240, stations: SUBWAY_GEOMETRIES["2"] },
        { routeId: "4", durationSecs: 600,  headwaySecs: 330, stations: SUBWAY_GEOMETRIES["4"] },
        { routeId: "5", durationSecs: 2400, headwaySecs: 300, stations: SUBWAY_GEOMETRIES["5"] },
        { routeId: "6", durationSecs: 1800, headwaySecs: 360, stations: SUBWAY_GEOMETRIES["6"] }
    ];

    SUBWAY_CONFIGS.forEach(cfg => {
        const numTrains = Math.floor(cfg.durationSecs / cfg.headwaySecs);
        const totalSegs = cfg.stations.length - 1;
        const segLength = 1 / totalSegs;

        [0, 1].forEach(direction => {
            const stations = direction === 0 ? cfg.stations : [...cfg.stations].reverse();

            for (let i = 0; i < numTrains; i++) {
                const progress = ((nowSecs + i * cfg.headwaySecs) % cfg.durationSecs) / cfg.durationSecs;
                const index = Math.min(Math.floor(progress / segLength), totalSegs - 1);
                const segProgress = (progress - index * segLength) / segLength;
                
                const p1 = stations[index];
                const p2 = stations[index + 1];

                const lat = p1[0] + (p2[0] - p1[0]) * segProgress;
                const lng = p1[1] + (p2[1] - p1[1]) * segProgress;
                
                let bearing = Math.round((Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) * 180 / Math.PI + 360) % 360);

                subways.push({
                    id: `SUBWAY-${cfg.routeId}-${direction}-${i}`,
                    routeId: cfg.routeId,
                    directionId: direction,
                    latitude: lat,
                    longitude: lng,
                    bearing: bearing,
                    speed: 12.5, // ~45 km/h
                    occupancyStatus: "FEW SEATS AVAILABLE",
                    currentStatus: "IN TRANSIT TO",
                    isAnticipated: true,
                    timestamp: Math.floor(Date.now() / 1000)
                });
            }
        });
    });

    return subways;
}

// --- WORKER 2: REAL-TIME DATA (Runs every 10 seconds) ---
async function updateRealtimeData() {
    try {
        const response = await fetch(GTFS_REALTIME_URL, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' 
            }
        });

        if (!response.ok) throw new Error(`External TTC API Error: ${response.status}`);

        const buffer = await response.arrayBuffer();
        const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

        const surfaceBuses = feed.entity.map(entity => {
            if (entity.vehicle && entity.vehicle.position) {
                const vehicleObj = entity.vehicle;
                const vehicleId = (vehicleObj.vehicle && vehicleObj.vehicle.id) ? vehicleObj.vehicle.id : entity.id;
                const routeId = vehicleObj.trip ? vehicleObj.trip.routeId : 'Unknown';
                
                return {
                    id: vehicleId,
                    routeId: routeId,
                    directionId: vehicleObj.trip ? vehicleObj.trip.directionId : null,
                    latitude: vehicleObj.position.latitude,
                    longitude: vehicleObj.position.longitude,
                    bearing: vehicleObj.position.bearing || 0,
                    speed: vehicleObj.position.speed || 0, // speed in m/s (can convert to km/h in UI)
                    occupancyStatus: formatEnum(vehicleObj.occupancyStatus, OCCUPANCY_MAP),
                    currentStatus: formatEnum(vehicleObj.currentStatus, STATUS_MAP),
                    stopId: vehicleObj.stopId || null,
                    timestamp: vehicleObj.timestamp ? Number(vehicleObj.timestamp) : Math.floor(Date.now() / 1000)
                };
            }
            return null;
        }).filter(bus => bus !== null);

        // Combine surface vehicles + anticipated subway locations
        const anticipatedSubways = generateAnticipatedSubways();
        const buses = [...surfaceBuses, ...anticipatedSubways];

        // Stale Detection Logic
        const currentDataString = JSON.stringify(buses);
        if (currentDataString === cache.lastDataString && buses.length > 0) {
            cache.staleCount++;
        } else {
            cache.staleCount = 0;
            cache.buses = buses;
            cache.lastDataString = currentDataString;
        }

    } catch (error) {
        console.error("[Realtime Worker] Fetch failed:", error.message);
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
        service: "TTC Vehicle Tracker Backend API",
        activeVehicles: cache.buses.length,
        loadedRoutes: Object.keys(cache.routes).length,
        staleCount: cache.staleCount
    });
});

// 1. Get Real-time TTC Vehicles
app.get('/buses', (req, res) => {
    res.set('X-Stale-Count', cache.staleCount);
    res.set('Cache-Control', 'public, max-age=3');
    res.json(cache.buses);
});

// 2. Get Static Route List
app.get('/routes', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.json(cache.routes);
});

app.listen(port, () => {
    console.log(`TTC Tracker Backend running on port ${port}`);
});
