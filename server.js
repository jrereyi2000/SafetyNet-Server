import express from "express";
import http from "http";
import path from "path";
import 'dotenv/config'
import initApi from "./api/index.js";
import updater from "./lib/server/updater.js";
import cors from 'cors';

const PORT = process.env.PORT || 1930;

const app = express();
app.use(cors());
const server = http.createServer(app);

const dirname = process.cwd();
const publicPath = path.join(dirname, "public");
console.log(`Serving files from ${publicPath}`);
app.use("/lib/client", express.static(path.join(dirname, "lib/client")));
app.use(express.static(publicPath));
updater(server, publicPath);

const main = async () => {
  await initApi(app);
  server.listen(PORT, () => {
  // console.log(`Listening on port ${PORT}.`);
  });
};
main();
