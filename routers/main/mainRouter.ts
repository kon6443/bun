import express from "express";

const mainRouter = express.Router();

mainRouter.get("/", (req, res) => {
  const status = 200;
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const date = now.getDate();
  const message = `${year}.${month}.${date}[${req.method}]::${req.originalUrl}`;
  res.status(status).json({ message });
});

export default mainRouter;
