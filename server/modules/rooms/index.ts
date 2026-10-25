// The HTTP surface for team rooms, mounted by the app at /api/rooms.
export { default as roomsRoutes } from './rooms.routes.js';

// The turn engine needs the provider runtime; the app hands it over at startup
// and takes it back on shutdown.
export { roomTurnEngine } from './services/room-turn-engine.service.js';
