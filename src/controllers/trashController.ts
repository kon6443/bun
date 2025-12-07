import { AppDataSource } from "../database/data-source";
import { User } from "../entities/User";

class TrashController {
  constructor() {}

  async doTrash() {
    try {
        const userRepository = AppDataSource.getRepository(User);
        const count = await userRepository.count();
        console.log('total:', count);
    } catch (err) {
      throw err;
    }
  }

  /**
   * CPU 사용률을 인위적으로 높이기 위한 대량 연산 루프 예제
   * iterations 값을 키울수록 더 높은 부하를 유발합니다.
   */
  runCpuIntensiveLoop(iterations = 5_000_000) {
    let accumulator = 0;

    for (let i = 0; i < iterations; i++) {
      // 연속적인 삼각함수, 제곱근 계산 등 CPU에 부담을 주는 연산을 조합
      const value = Math.sqrt((i % 1_000) + 1) * Math.sin(i);
      accumulator += value;
    }

    console.log(
      `[trashController][runCpuIntensiveLoop] iterations=${iterations}, result=${accumulator.toFixed(
        2
      )}`
    );

    return accumulator;
  }
}

const trashControllerInstance = new TrashController();
export default trashControllerInstance;
