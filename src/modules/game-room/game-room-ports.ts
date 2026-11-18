/**
 * 방 서비스 ↔ 게이트웨이 경계 타입 (게임 공용 — 테트리스 대전·포트리스). 두 방 서비스가 같은 이름·같은 모양으로
 * 따로 선언하던 것을 모은다(docs/tasks/refactor-perf-b-2026-11 B2). 게임별로 다른 필드는 각 게임이 확장한다.
 */

/** 요청한 소켓의 신원 공통부 — 게이트웨이가 소켓에서 꺼내 넘긴다(클라이언트 페이로드에서 받지 않는다). 게임은 스킨 등을 더한다 */
export interface GameSocketIdentity {
  socketId: string;
  userId: number | null;
  /** 빈도 제한·비밀번호 잠금용 IP (X-Forwarded-For 마지막 값 — 게이트웨이 clientIp) */
  ip: string;
}

/** 입장 요청에 실려 오는 클라이언트 특성(tetris-audit D-007·D-010) */
export interface ClientTraits {
  tabId?: string;
  heartbeat?: boolean;
}

/**
 * 방 채널에 지금 붙어 있는 소켓 id 집합(전 레플리카). 게이트웨이가 주입한다 — 서비스가 socket.io 서버에 직접 의존하지 않게.
 * 실패(타임아웃 등)면 throw — 호출 쪽은 이번 확인을 건너뛴다.
 */
export type LiveSocketProbe = (code: string) => Promise<Set<string>>;

/** 하트비트가 끊긴 소켓을 서버에서 끊는다(게이트웨이 주입, 다른 레플리카 소켓도 어댑터가 전달) */
export type SocketEvictor = (socketIds: string[]) => void;

/**
 * 요청 결과로 돌려줄 수 없는 방 변경(정리만 일어난 경우·전원 정리로 삭제·생존 확인)을 알리는 콜백.
 * 게이트웨이가 roomState·roomsChanged로 방송한다. room=null이면 방이 삭제됨.
 */
export type GameRoomChangeListener<TRoomState> = (code: string, room: TRoomState | null, lobbyChanged: boolean) => void;
