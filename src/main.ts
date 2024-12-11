import express from "express";
import { CookieOptions, NextFunction, Request, Response } from "express";

import "express-async-errors";
import * as path from "path";

// router
import router from "./routers/index";

const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const helmet = require("helmet");

// need to working on in.
// const { swaggerUi, specs } = require("./modules/swagger");

const isLocal = process.env.ENV?.toUpperCase() == "LOCAL";

const app = express();
const port = process.env.EXPRESS_PORT || 3500;
const domain = process.env.DOMAIN;

// app.use(cors(corsOptions));
app.use(cors());
app.use(helmet());
app.use(cookieParser());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

app.use((req: Request, res: Response, next: NextFunction) => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const date = now.getDate();
  // const message = `${year}.${month}.${date}[${req.method}]:: ${domain}:${port}${req.originalUrl}`;
  const message = `${year}.${month}.${date}::[${req.method}] ${domain}:${port}${req.originalUrl}`;
  console.log(message);
  next();
});
app.use("/api", router);

const server = app.listen(port, () => {
  console.log(`Listening on port ${port}...`);
});

server.on("error", console.error);
