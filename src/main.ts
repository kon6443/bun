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
const { swaggerUi, specs, externalSpecs } = require("./modules/swagger");

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
];

const corsOptions = {
  origin: function (origin: any, callback: any) {
    if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
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

// const server = app.listen(port, "0.0.0.0", () => {
//   console.log(`Listening on port ${port}...`);
// });
// server.on("error", console.error);

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
