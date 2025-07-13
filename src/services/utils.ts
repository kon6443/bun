class UtilService {
  handleError(err: any) {
    console.error("err:", err);
    throw err;
  }
}

const utilServiceInstance = new UtilService();

export default utilServiceInstance;
