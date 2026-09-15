import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)), "public");
const port = Number.parseInt(process.env.HTTP_PORT ?? "5173", 10);
const host = process.env.HTTP_HOST ?? "127.0.0.1";
const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"]
]);

function resolvePath(url) {
  const pathname = new URL(url, `http://localhost:${port}`).pathname;
  const target = pathname === "/" ? "/index.html" : pathname;
  const fullPath = resolve(root, `.${target}`);
  const pathFromRoot = relative(root, fullPath);
  return pathFromRoot && !pathFromRoot.startsWith("..") && !pathFromRoot.startsWith(sep)
    ? fullPath
    : join(root, "index.html");
}

const server = createServer(async (req, res) => {
  if (req.url === "/healthz" || req.url === "/readyz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: req.url === "/healthz" ? "ok" : "ready" }));
    return;
  }

  if (new URL(req.url ?? "/", `http://localhost:${port}`).pathname === "/runtime-config.js") {
    const config = await readFile(join(root, "runtime-config.template.js"), "utf8");
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    res.end(config);
    return;
  }

  const filePath = resolvePath(req.url ?? "/");
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("not a file");
    res.writeHead(200, { "Content-Type": types.get(extname(filePath)) ?? "application/octet-stream" });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    createReadStream(join(root, "index.html")).pipe(res);
  }
});

server.listen(port, host, () => {
  const address = server.address();
  const selectedPort = typeof address === "object" && address ? address.port : port;
  console.log(`svc-web web seed listening on http://${host}:${selectedPort}`);
});
