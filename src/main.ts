import express from "express";
import { NextFunction, Request, Response } from "express";
import "express-async-errors";
import { oracleAutonomousRepository } from "./repositories/oracleAutonomousRepository";

// router
import router from "./routers/index";

const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const helmet = require("helmet");
const { swaggerUi, specs } = require("./modules/swagger");

// need to working on in.
// const { swaggerUi, specs } = require("./modules/swagger");

const isLocal = process.env.ENV?.toUpperCase() == "LOCAL";

const app = express();
const port = process.env.EXPRESS_PORT || 3500;
const domain = process.env.DOMAIN;

const allowedOrigins = [
  "http://localhost",
  "http://localhost:3000",
  "http://localhost:3500",
  "https://fivesouth.duckdns.org",
];

const corsOptions = {
  origin: function (origin: any, callback: any) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
};

app.use(cors(corsOptions));
// app.use(cors());
app.use(helmet());
app.use(cookieParser());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
if (isLocal) app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs));

app.use((req: Request, res: Response, next: NextFunction) => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const date = now.getDate();
  // const message = `${year}.${month}.${date}[${req.method}]:: ${domain}:${port}${req.originalUrl}`;
  const message = `${year}.${month}.${date}::[${req.method}] ${domain}${req.originalUrl}`;
  console.log(message);
  next();
});

app.use("/api", router);

const startServer = async () => {
  try {
    await oracleAutonomousRepository.initialize();

    const server = app.listen(port, "0.0.0.0", () => {
      console.log(`Listening on port ${port}...`);
    });

    server.on("error", console.error);
  } catch (err) {
    console.error("서버 시작 중 오류 발생:", err);
    process.exit(1);
  }
};

startServer();

process.on("SIGINT", async () => {
  await oracleAutonomousRepository.close();
  process.exit(0);
});

function errorHandler(err: any, req: any, res: any, next: any) {
  const user = req.headers.user;
  const logs: string[] = [];
  // if (user?.id) {
  //   // kakao login
  //   logs.push(`userId: [${user?.id}]`);
  // } else if (user?.userId) {
  //   // partners login
  //   logs.push(`PARTNERS userId: [${user?.userId}]`);
  // }
  const time = new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" });
  let reqIp = req.headers["x-forwarded-for"] || req.connection.remoteAddress;
  if (reqIp == "::1" || reqIp == "localhost") {
    // ::1 - IPv6에서 로컬호스트. 따라서 모든 로컬호스트를 의미하는 ip 는 127.0.0.1 로 수정
    reqIp = "127.0.0.1";
  } else if (reqIp.startsWith("::ffff:")) {
    // ::ffff: - 로 시작하는 주소는 IPv4 주소를 IPv6 형식으로 표현함. ex) ::ffff:192.168.0.1
    // 이경우 IPv4 주소만 추출하여 사용
    reqIp = reqIp.split(":").pop();
  }
  logs.push(`[${reqIp}]:: ${time} [${req.method}]: ${req.originalUrl}\n`);
  if (!err?.hideServerLog) {
    console.log(logs.join(", "), err);
  }
  // console.log(`userId: [${user?.id}], ${time} [${req.method}]: ${req.path}\n`, err);
  if (res.headersSent) {
    return next(err);
  }
  // let errStatus;
  // if (!err.status) {
  // errStatus = 500;
  // err.message = "Internal Server Error";
  // } else {
  //   errStatus = err.status;
  // }
  return res
    .status(err.status)
    .json({ status: err.status, message: err.message });
}
app.use(errorHandler);
