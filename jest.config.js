module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  // 테스트 코드 자체는 커버리지 분모에서 뺀다 — 넣으면 "무엇이 검증되지 않았는지"라는
  // 커버리지의 신호가 테스트 헬퍼의 미사용 라인에 묻혀 왜곡된다.
  coveragePathIgnorePatterns: ['/node_modules/', '\\.spec\\.ts$', '/__spec__/'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  // tsconfig.json의 paths와 1:1로 유지할 것 (누락 시 해당 alias를 쓰는 테스트가 모듈 해석 실패)
  moduleNameMapper: {
    '^@common/(.*)$': '<rootDir>/common/$1',
    '^@entities/(.*)$': '<rootDir>/entities/$1',
    '^@modules/(.*)$': '<rootDir>/modules/$1',
    '^@config/(.*)$': '<rootDir>/config/$1',
    '^@/(.*)$': '<rootDir>/$1',
  },
};
