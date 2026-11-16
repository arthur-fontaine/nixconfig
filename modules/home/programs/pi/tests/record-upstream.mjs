// A loopback stand-in for api.anthropic.com that forwards each request and records it, for
// advisor-check: node record-upstream.mjs <port> <dir>. One numbered folder per request,
// with its headers (credentials redacted), body, response headers and response body.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

const [port, outDir] = [Number(process.argv[2]), process.argv[3]];
fs.mkdirSync(outDir, { recursive: true });
let count = 0;

http
  .createServer(async (req, res) => {
    const dir = path.join(outDir, String(++count).padStart(3, "0"));
    fs.mkdirSync(dir);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers };
    for (const name of ["host", "connection", "accept-encoding", "content-length"]) delete headers[name];
    const logged = { ...headers };
    for (const name of ["authorization", "x-api-key"]) if (logged[name]) logged[name] = "<redacted>";
    fs.writeFileSync(path.join(dir, "request.json"), JSON.stringify({ method: req.method, url: req.url, headers: logged }, null, 2));
    fs.writeFileSync(path.join(dir, "request-body"), body);
    const upstream = https.request(
      { host: "api.anthropic.com", method: req.method, path: req.url, headers: { ...headers, "accept-encoding": "identity", "content-length": body.length } },
      (response) => {
        fs.writeFileSync(path.join(dir, "response.json"), JSON.stringify({ status: response.statusCode, headers: response.headers }, null, 2));
        const out = { ...response.headers };
        delete out["transfer-encoding"];
        delete out.connection;
        res.writeHead(response.statusCode ?? 502, out);
        const file = fs.createWriteStream(path.join(dir, "response-body"));
        response.on("data", (chunk) => {
          file.write(chunk);
          res.write(chunk);
        });
        response.on("end", () => {
          file.end();
          res.end();
        });
      },
    );
    upstream.on("error", (error) => {
      fs.writeFileSync(path.join(dir, "error"), String(error));
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    upstream.end(body);
  })
  .listen(port, "127.0.0.1", () => console.log(`recording on ${port}`));
