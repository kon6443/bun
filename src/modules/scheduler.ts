import schedule from 'node-schedule';
import trashControllerInstance from '../controllers/trashController';

// * * * * * *
// | | | | | |
// | | | | | +---- Day of the week (0 - 7) (Sunday is both 0 and 7)
// | | | | +------ Month (1 - 12)
// | | | +-------- Day of the month (1 - 31)
// | | +---------- Hour (0 - 23)
// | +------------ Minute (0 - 59)
// +-------------- Second (0 - 59)
//
// 요일: 매일 (*)
// 월: 매월 (*)
// 일: 매일 (*)
// 시: 0시 (즉, 자정)
// 분: 0분
// 초: 0초

let env = process.env.ENV?.toUpperCase() ?? '';
let taskNumber = Number(process.env.TASK_SLOT);
env = 'QA'; // for testing
taskNumber = 1; // for testing
console.log('env:', env);
const taskSlots = ['QA', 'PROD'];

const scheduleJobs = () => {
  if (taskSlots.includes(env) && taskNumber == 1) {
    // OCI 인스턴스 쓰레기 작업 실행: 1분마다 실행
    // schedule.scheduleJob('0/2 * * * * *', () =>
    schedule.scheduleJob('0/30 * * * * *', () =>
      handleAsyncTryCatch(trashControllerInstance.doTrash),
    );

  }
};

async function handleAsyncTryCatch(fn: Function) {
  try {
    // console.log(`SCHEDULER START::[${fn.name}] - [${new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })}]`);
    console.log(`SCHEDULER START::[${fn.name}] - [${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}]`);
    await fn();
  } catch (err: any) {
    console.error(
      `SCHEDULER ERROR::[${fn.name}] - [${new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })}]\n`,
      err,
    );
  }
}

export default scheduleJobs;