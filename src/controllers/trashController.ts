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
}

const trashControllerInstance = new TrashController();
export default trashControllerInstance;
