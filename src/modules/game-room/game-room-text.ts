import { checkPlayerName, containsForbiddenWord } from '../games/player-name-policy';

/**
 * 대전 방 텍스트 정책 (게임 공용) — 방 이름·플레이어 이름·채팅. 판정만 돌려주고 도메인 에러로 바꾸는 것은 게임 쪽 몫이다.
 */

/**
 * 방 이름·채팅에 금지하는 문자: 제어(Cc)·서로게이트(Cs)·사용자 정의(Co)·미할당(Cn) + bidi 제어
 * (U+202A–202E 임베딩·오버라이드, U+2066–2069 격리, U+200E·200F 방향 표시, U+061C 아랍 문자 표시).
 * 서식 문자(Cf) 전체를 막지 않는 이유: ZWJ(U+200D)·이모지 변형 선택자(U+FE0F) 등 이모지 구성 문자가 Cf/Mn이라
 * 👩‍💻 같은 이모지가 막힌다. 제로폭 문자로 금칙어를 쪼개는 우회는 금칙어 정규화(한글·영문만 남김)가 막는다.
 */
const DISALLOWED_CHARS = /[\p{Cc}\p{Cs}\p{Co}\p{Cn}\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/u;

export const containsDisallowedChars = (text: string): boolean => DISALLOWED_CHARS.test(text);

/** 플레이어 이름 — 랭킹 이름 정책과 같다. null이면 통과 */
export { checkPlayerName };

/** 방 이름: 1~maxLength자, 제어·서식 문자 금지, 금칙어 금지 (플레이어 이름보다 허용 문자가 넓다 — 이모지·문장부호 허용). null이면 통과 */
export function checkRoomName(name: string, maxLength: number): 'INVALID' | 'FORBIDDEN' | null {
  const length = Array.from(name).length;
  if (length === 0 || length > maxLength || containsDisallowedChars(name)) return 'INVALID';
  if (containsForbiddenWord(name)) return 'FORBIDDEN';
  return null;
}

/** 채팅 문장 — 제어·bidi 문자(줄바꿈·방향 오버라이드 등)는 화면을 깨거나 다른 사람의 문장처럼 위장하는 데 쓰인다. 금칙어도 막는다 */
export const chatTextAllowed = (text: string): boolean => !containsDisallowedChars(text) && !containsForbiddenWord(text);
