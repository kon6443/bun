/**
 * 대전 래퍼가 쓰는 엔진 API — 엔진 경로는 이 파일에만 둔다
 * 백엔드 사본은 이 파일의 import 경로만 다르다(엔진 사본 위치가 달라서). 나머지 파일(테스트 포함)은 바이트 단위로 같다
 * 테스트가 쓰는 엔진 이름(ACTION·PIECE·getDropY)도 여기서 내보낸다 — 테스트도 엔진을 직접 import하지 않는다
 */

export {
  ACTION,
  ACTION_CODE_MAX,
  ARR_MAX,
  ARR_MIN,
  BOARD_ROWS,
  BOARD_WIDTH,
  DAS_MAX,
  DAS_MIN,
  MAX_FRAMES,
  MAX_INPUT_LENGTH,
  PIECE,
  SEED_MAX,
  type GameState,
  type LockEvent,
  createGame,
  getBoardHash,
  getDropY,
  stepFrame,
} from '../../games/tetris-engine';
