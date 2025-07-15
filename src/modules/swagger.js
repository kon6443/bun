const swaggerUi = require("swagger-ui-express");
const swaggereJsdoc = require("swagger-jsdoc");
const path = require("path");
const fs = require("fs");

const getAllFiles = (dir) => {
  return fs.readdirSync(dir).reduce((files, file) => {
    const name = path.join(dir, file);
    const isDirectory = fs.statSync(name).isDirectory();
    return isDirectory
      ? [...files, ...getAllFiles(name)]
      : [...files, path.resolve(name)];
  }, []);
};

const serverHost = process.env.SERVER_HOST || "localhost";
const serverPort = process.env.PORT || 3500;
const options = {
  swaggerDefinition: {
    openapi: "3.0.0",
    info: {
      title: "FiveSouth Swagger API Documents",
      version: "1.0.0",
      description: "FiveSouth Swagger API Documents",
    },
    host: `${serverHost}:${serverPort}`,
    basePath: "/",
  },
  apis: [path.resolve(__dirname, "../../src/routers/**/*.*")],
  operationsSorter: "alpha",
};

const specs = swaggereJsdoc(options);

module.exports = {
  swaggerUi,
  specs,
};
