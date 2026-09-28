import { test } from "node:test";
import assert from "node:assert/strict";
import { banner, app } from "./index";

// Importing the module must not bind a port, otherwise the test run and the
// dev server would collide. `start()` only runs for `node dist/index.js`.
test("importing the server does not start it", () => {
  assert.equal(typeof app, "function");
  assert.equal(typeof app.listen, "function");
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
