import { randomInt } from 'node:crypto';

/**
 * 사용자 관련 공통 유틸리티 함수
 */

/**
 * 기본 닉네임 생성: userName이 null/undefined인 경우 "사용자{userId}" 형식으로 반환
 * @param userName - 사용자 이름 (null/undefined 가능)
 * @param userId - 사용자 ID
 * @returns 표시할 이름
 */
export function getDisplayName(userName: string | null | undefined, userId: number): string {
  return userName ?? `사용자${userId}`;
}

/**
 * 팀 안에서 보일 이름: 팀 닉네임 → 계정 닉네임 → "사용자{userId}" (docs/tasks/team-nickname D-001·D-004)
 * 팀 닉네임은 가입 때 채워지므로 계정 닉네임 대체는 채우기 전 데이터(NULL)에 대한 안전망이다.
 */
export function getTeamDisplayName(
  teamNickname: string | null | undefined,
  userName: string | null | undefined,
  userId: number,
): string {
  return teamNickname || getDisplayName(userName, userId);
}

const NICKNAME_ADJECTIVES = [
  '용감한', '느긋한', '반짝이는', '수줍은', '씩씩한', '졸린', '명랑한', '조용한', '재빠른', '다정한',
  '엉뚱한', '똑똑한', '포근한', '당당한', '신나는', '차분한', '귀여운', '배고픈', '부지런한', '행복한',
] as const;

const NICKNAME_ANIMALS = [
  '수달', '판다', '고양이', '강아지', '여우', '토끼', '펭귄', '다람쥐', '부엉이', '고래',
  '코알라', '햄스터', '거북이', '사슴', '돌고래', '알파카', '너구리', '오리', '참새', '하마',
] as const;

/**
 * 신규 가입자 기본 닉네임: 형용사 + 동물 + 4자리 숫자 (예: "용감한수달4821") — D-002
 * 유니크를 강제하지 않는다(계정 닉네임은 중복 허용). 길이는 계정 닉네임 상한 20자 이내.
 */
export function generateRandomNickname(): string {
  const adjective = NICKNAME_ADJECTIVES[randomInt(NICKNAME_ADJECTIVES.length)];
  const animal = NICKNAME_ANIMALS[randomInt(NICKNAME_ANIMALS.length)];
  const digits = String(randomInt(10000)).padStart(4, '0');
  return `${adjective}${animal}${digits}`;
}
