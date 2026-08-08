# GTA Public Transportation Tracker - Backend

Express.js backend server for real-time TTC (Toronto Transit Commission) bus, streetcar, and subway tracking. 

## Features
- **GTFS-Realtime Integration**: Fetches vehicle location data directly from `https://bustime.ttc.ca/gtfsrt/vehicles` every 10 seconds.
- **GTFS Static Integration**: Parses City of Toronto Open Data GTFS `routes.txt` to map route numbers, names, colors, text colors, and route types.
- **Stale Data Monitoring**: Tracks feed health and returns `X-Stale-Count` headers to clients.
- **CORS Enabled**: Readily serves frontend clients.

## Endpoints
- `GET /` - Health check & server stats.
- `GET /buses` - Real-time vehicle coordinates, bearing, speed, occupancy, and route IDs.
- `GET /routes` - Static route details mapping route IDs to names, route types, and color codes.

## Getting Started
```bash
npm install
npm start
```
Default server runs at `http://localhost:3000`.
