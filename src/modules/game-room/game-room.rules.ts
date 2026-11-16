/**
 * 방 라이프사이클 순수 규칙 (게임 공용) — Redis·에러 클래스·게임 규칙을 모른다. 던지지 않고 값만 돌려준다:
 * 거부(NOT_IN_ROOM 등)는 각 게임 방 서비스가 자기 에러로 바꾼다.
 *
 * 테트리스 대전·포트리스 방 서비스가 같은 규칙을 두 벌 들고 있던 것을 여기로 모은다(docs/tasks/fortress DECISIONS D-014 F3c의 첫 단계).
 */

/** 규칙이 읽는 플레이어 필드 — 각 게임 StoredPlayer의 부분집합 */
export interface GameRoomSeat {
  playerId: string;
  connected: boolean;
  socketId: string | null;
  disconnectedAt: number | null;
}

/** 규칙이 읽는 방 필드 — match는 진행 중(PLAYING)이거나 직전(RESULT) 경기의 참가자 목록 */
export interface GameRoomShape<P extends GameRoomSeat> {
  hostId: string;
  status: 'WAITING' | 'PLAYING' | 'RESULT';
  players: P[];
  match?: { playerIds: string[] } | null;
}

/** 멤버십 = 방 기록의 플레이어 중 대표 소켓이 이 소켓인 사람. 클라이언트가 보낸 playerId는 믿지 않는다 */
export function findMemberBySocket<P extends GameRoomSeat>(
  room: GameRoomShape<P>,
  socketId: string,
): P | undefined {
  return room.players.find(p => p.socketId === socketId);
}

/** 이 플레이어가 지금 진행 중인 경기의 참가자인가 — 방이 PLAYING이고 경기 참가자 목록에 있다 */
export function isInPlayingMatch<P extends GameRoomSeat>(room: GameRoomShape<P>, playerId: string): boolean {
  return room.status === 'PLAYING' && room.match?.playerIds.includes(playerId) === true;
}

/** 자리를 끊김으로 표시한다 — 자리는 남기고 대표 소켓만 비운다(유예가 지나면 pruneDisconnected가 뺀다) */
export function markSeatDisconnected(player: GameRoomSeat, now: number): void {
  player.socketId = null;
  player.connected = false;
  player.disconnectedAt = now;
}

/** 플레이어 제거 + 방장이었으면 이양: 연결된 사람 중 가장 먼저 들어온 사람, 없으면 가장 먼저 들어온 사람 */
export function removeSeat<P extends GameRoomSeat>(room: GameRoomShape<P>, playerId: string): void {
  room.players = room.players.filter(p => p.playerId !== playerId);
  if (room.hostId !== playerId || room.players.length === 0) return;
  const next = room.players.find(p => p.connected) ?? room.players[0];
  room.hostId = next.playerId;
}

/**
 * WAITING·RESULT 방에서 유예가 지난 끊긴 플레이어를 뺀다(새 객체 — 원본은 그대로). PLAYING은 각 게임의 경기 쪽 유예가 처리하므로 건드리지 않는다
 */
export function pruneDisconnectedSeats<P extends GameRoomSeat, R extends GameRoomShape<P>>(
  source: R,
  now: number,
  graceMs: number,
): R {
  const room: R = { ...source, players: source.players.map(p => ({ ...p })) };
  if (room.status === 'PLAYING') return room;
  const expired = room.players.filter(
    p => !p.connected && p.disconnectedAt !== null && now - p.disconnectedAt >= graceMs,
  );
  for (const p of expired) removeSeat(room, p.playerId);
  return room;
}
