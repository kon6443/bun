import { oracleAutonomousRepository } from "../repositories/oracleAutonomousRepository";

class TrashController {
  constructor() {}

  async doTrash() {
    try {
        // const sql = `SELECT * FROM users`;
        const sql = `SELECT count(*) as cnt FROM users`;
        const fns: Function[] = [];
        for(let i=0; i<1; i++) {
            fns.push(()=>oracleAutonomousRepository.execute(sql));
        }
        let results = (await Promise.all(fns.map(fn=>fn()))).flat();
        const total = results.reduce((acc, curr) => acc + Number(curr.cnt), 0);
        console.log('total:', total);
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
