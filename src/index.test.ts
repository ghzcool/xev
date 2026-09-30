import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { banner, app } from "./index";

// Importing the module must not bind a port, otherwise the test run and the
// dev server would collide. `start()` only runs for `node dist/index.js`.
test("importing the server does not start it", () => {
  assert.equal(typeof app, "function");
  assert.equal(typeof app.listen, "function");
});

test("the proxy forwards the server's reasoning settings", () => {
  // This route used to resolve the LLM config and then send the caller's body
  // untouched, so a request through the proxy ignored LLM_REASONING_EFFORT while
  // the same request to /v1/systemone honored it.
  return new Promise<void>((resolve, reject) => {
    let captured: Record<string, unknown> = {};
    const upstream = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        captured = JSON.parse(raw) as Record<string, unknown>;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "0:0.5" } }] }));
      });
    });
    upstream.listen(0, "127.0.0.1", () => {
      const { port } = upstream.address() as AddressInfo;
      const server = app.listen(0, "127.0.0.1", () => {
        const { port: local } = server.address() as AddressInfo;
        fetch(`http://127.0.0.1:${local}/v1/proxy/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-llm-base-url": `http://127.0.0.1:${port}/v1`,
            "x-llm-api-key": "caller-key",
            "x-llm-extra-body": '{"reasoning_effort":"none"}',
          },
          body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
        })
          .then(() => {
            // The server's derived reasoning reaches the upstream call.
            assert.equal(captured.reasoning_effort, "none");
            // The caller's own body is still what got forwarded.
            assert.equal(captured.model, "m");
          })
          .then(() => server.close(() => upstream.close(() => resolve())))
          .catch((err: unknown) =>
            server.close(() => upstream.close(() => reject(err)))
          );
      });
    });
  });
});

test("the banner links the demo page and the API endpoints", () => {
  const lines = banner("http://localhost:3000").split("\n");
  assert.deepEqual(lines, [
    "  Demo page  http://localhost:3000/",
    "  Health     http://localhost:3000/health",
    "  Models     http://localhost:3000/v1/models",
    "  Evaluate   http://localhost:3000/v1/systemone  (POST)",
  ]);
});

test("the banner uses the host and port it was given", () => {
  assert.match(banner("http://[::1]:8080"), /http:\/\/\[::1\]:8080\//);
});

test("the banner contains no escape codes when there is no terminal", () => {
  // CI and piped output: OSC 8 sequences would show up as literal garbage.
  assert.equal(banner("http://localhost:3000").includes("\u001b"), false);
});
