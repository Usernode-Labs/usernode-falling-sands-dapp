#!/usr/bin/env node
// Exercises deriveAuthError (public/index.html) for the save/send error codes.
// The auth-error source is extracted from the single-file client and evaluated
// in a vm sandbox so the browser copy and the tested copy can never diverge.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const INDEX = path.join(ROOT, "public", "index.html");

const html = fs.readFileSync(INDEX, "utf8");

// Extract AUTH_ERR_REASONS / AUTH_ERR_SCOPES / deriveAuthError. The block ends
// right before the modal wiring below it.
const start = html.indexOf("const AUTH_ERR_REASONS");
const end = html.indexOf("const _aeModal");
if (start === -1 || end === -1 || end <= start) {
  console.error("test-auth-error: could not locate deriveAuthError source in public/index.html");
  process.exit(1);
}
const snippet = html.slice(start, end);

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(snippet + "\nthis.__out = { AUTH_ERR_REASONS, AUTH_ERR_SCOPES, deriveAuthError };", sandbox);
const { AUTH_ERR_REASONS, deriveAuthError } = sandbox.__out;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("  ok  " + name);
  } else {
    failures++;
    console.error("FAIL  " + name + (detail ? " — " + detail : ""));
  }
}

// --- NOWALLET: missing wallet bridge (the reported SND-SEND-UNKNOWN case) ---
{
  const info = deriveAuthError(new ReferenceError("sendTransaction is not defined"), "SEND");
  check("ReferenceError sendTransaction is not defined -> NOWALLET",
    info.code === "SND-SEND-NOWALLET" && info.message === AUTH_ERR_REASONS.NOWALLET,
    "got " + info.code);
}
{
  const info = deriveAuthError(new TypeError("sendTransaction is not a function"), "SEND");
  check("TypeError sendTransaction is not a function -> NOWALLET",
    info.code === "SND-SEND-NOWALLET", "got " + info.code);
}
{
  const info = deriveAuthError(new Error("No Usernode wallet bridge: sendTransaction unavailable"), "SEND");
  check("btnSend guard error -> NOWALLET", info.code === "SND-SEND-NOWALLET", "got " + info.code);
}
{
  const info = deriveAuthError(new TypeError("Cannot read properties of undefined (reading 'sendTransaction')"), "SEND");
  check("cannot-read-properties naming sendTransaction -> NOWALLET",
    info.code === "SND-SEND-NOWALLET", "got " + info.code);
}

// --- known reasons unchanged ---
{
  const info = deriveAuthError(new Error("User rejected"), "SEND");
  check("cancel still wins -> CANCEL", info.code === "SND-SEND-CANCEL", "got " + info.code);
}
{
  const info = deriveAuthError({ message: "HTTP 503" }, "SEND");
  check("503 -> numeric SERVER code, message unchanged",
    info.code === "SND-SEND-503" && info.message === AUTH_ERR_REASONS.SERVER, "got " + info.code);
}
{
  const info = deriveAuthError(new Error("foo is not a function"), "SEND");
  check("unrelated 'is not a function' stays UNKNOWN",
    info.code === "SND-SEND-UNKNOWN", "got " + info.code);
}

// --- UNKNOWN detail appended to the message ---
{
  const info = deriveAuthError(new Error("foo is not a function"), "SEND");
  check("UNKNOWN message ends with Details:",
    info.message === AUTH_ERR_REASONS.UNKNOWN + " Details: foo is not a function",
    "got " + JSON.stringify(info.message));
}
{
  const info = deriveAuthError(new Error("x".repeat(400)), "SEND");
  check("UNKNOWN detail cut to 160 chars",
    info.message === AUTH_ERR_REASONS.UNKNOWN + " Details: " + "x".repeat(160),
    "len " + (info.message.length - AUTH_ERR_REASONS.UNKNOWN.length));
}
{
  const info = deriveAuthError(null, "SEND");
  check("null error -> UNKNOWN with no Details suffix",
    info.reason === "UNKNOWN" && info.message === AUTH_ERR_REASONS.UNKNOWN,
    "got " + JSON.stringify(info.message));
}
{
  // Known reasons never get the Details suffix.
  const info = deriveAuthError(new Error("User rejected"), "SEND");
  check("known reason message has no Details suffix",
    info.message === AUTH_ERR_REASONS.CANCEL, "got " + JSON.stringify(info.message));
}
{
  // Clipboard payload still carries the full (300-char) detail for triage.
  const raw = "d".repeat(400);
  const info = deriveAuthError(new Error(raw), "SEND");
  const clipboardDetail = (info.clipboard.split("\n").find(l => l.startsWith("Detail: ")) || "").slice("Detail: ".length);
  check("clipboard Detail line still holds up to 300 chars",
    clipboardDetail === "d".repeat(300), "len " + clipboardDetail.length);
}

// --- btnSend guard wiring: the guard must exist inside the send handler and
// throw before sendTransaction is called ---
{
  const guardAt = html.indexOf("typeof sendTransaction !== \"function\"");
  const sendAt = html.indexOf("await sendTransaction(APP_PUBKEY");
  const tryAt = html.indexOf("btnSend.addEventListener(\"click\"");
  check("btnSend guard present and ordered before sendTransaction",
    guardAt > -1 && sendAt > guardAt && tryAt > -1 && guardAt > tryAt && guardAt < sendAt);
}

if (failures) {
  console.error("\ntest-auth-error: " + failures + " failure(s)");
  process.exit(1);
}
console.log("\ntest-auth-error: all passed");