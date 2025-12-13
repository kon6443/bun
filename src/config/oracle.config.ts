import { registerAs } from '@nestjs/config';

export default registerAs('oracle', () => ({
  libDir: process.env.ORACLE_LIB_DIR,
  walletPath: process.env.ORACLE_WALLET_PATH,
}));

