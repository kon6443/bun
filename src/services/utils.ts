class UtilService {
  // handleError(err: any) {
  handleError({
    message,
    status,
    hideServerLog,
  }: {
    message: string;
    status: number;
    hideServerLog?: number;
  }) {
    if (!hideServerLog) {
      console.error("handle err err:", new Error(message));
    }
    throw { status, message, hideServerLog };
  }
}

const utilServiceInstance = new UtilService();

export default utilServiceInstance;
