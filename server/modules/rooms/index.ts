// The HTTP surface for team rooms, mounted by the app at /api/rooms.
export { default as roomsRoutes } from './rooms.routes.js';

// The turn engine needs the provider runtime; the app hands it over at startup
// and takes it back on shutdown.
export { roomTurnEngine } from './services/room-turn-engine.service.js';

// 예약 디스패처가 룸이 된 대화로 가는 예약을 룸 메시지로 올릴 때 쓴다.
export { roomsService } from './services/rooms.service.js';
