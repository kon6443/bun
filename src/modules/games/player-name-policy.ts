import { GAME_PLAYER_NAME_MAX_LENGTH } from '../../common/constants/app.constants';

/**
 * 랭킹 표시 이름 금칙어 (docs/tasks/games D-003 — 비로그인 등록이라 서버가 판정한다)
 *
 * 형식(길이·허용 문자)은 DTO가 먼저 막는다. 여기서는 의미만 본다: 욕설·성적 표현·운영자 사칭.
 * 우회(공백·숫자·특수문자 끼워 넣기, 대소문자)를 막으려고 한글·영문만 남기고 소문자로 바꾼 뒤 포함 여부를 본다.
 * 목록은 운영하며 늘린다 — 오탐이 나면 더 긴 표현으로 좁힌다.
 */
const FORBIDDEN_WORDS = [
  // 욕설
  '시발', '씨발', '씨바', '시바', '쉬발', '씨팔', '시팔', '병신', '븅신', '빙신', '개새', '새끼', '좆', '존나', '졸라',
  '지랄', '염병', '닥쳐', '꺼져', '엿먹', '느금', '니애미', '니미', '애미', '애비', '미친놈', '미친년', '썅', '쌍놈',
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'dick',
  // 성적 표현
  '섹스', '보지', '자지', '강간', 'sex', 'porn',
  // 운영자 사칭
  '운영자', '관리자', 'admin', 'operator',
] as const;

/** 이름 형식 (DESIGN §3) — DTO가 정규화(trim·연속 공백 1개)한 뒤의 값에 적용. 바이트 상한 = 컬럼 VARCHAR2(48 BYTE) */
const PLAYER_NAME_MAX_BYTES = 48;
const PLAYER_NAME_PATTERN = /^[가-힣A-Za-z0-9 _-]+$/;

/** 한글 완성형·영문만 남기고 소문자로 */
const normalize = (name: string): string => name.toLowerCase().replace(/[^가-힣a-z]/g, '');

export function containsForbiddenWord(name: string): boolean {
  const normalized = normalize(name);
  return FORBIDDEN_WORDS.some((word) => normalized.includes(word));
}

/**
 * 이름 판정 — 형식 위반은 INVALID, 금칙어는 FORBIDDEN, 통과면 null.
 * DTO 대신 여기서 판정하는 이유: 이름 오류만 전용 code로 돌려줘야 프론트가 "이름만 바꿔 다시 제출"과
 * 리플레이·세션 형식 오류(VALIDATION_ERROR, 재시도 불가)를 구분한다.
 */
export function checkPlayerName(name: string): 'INVALID' | 'FORBIDDEN' | null {
  const length = Array.from(name).length;
  if (
    length === 0 ||
    length > GAME_PLAYER_NAME_MAX_LENGTH ||
    Buffer.byteLength(name, 'utf8') > PLAYER_NAME_MAX_BYTES ||
    !PLAYER_NAME_PATTERN.test(name)
  ) {
    return 'INVALID';
  }
  return containsForbiddenWord(name) ? 'FORBIDDEN' : null;
}
