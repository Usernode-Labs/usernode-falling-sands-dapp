// Regression guard: a smart-quote autocorrect once replaced ASCII quotes
// with curly quotes (U+2018 '‘' / U+2019 '’') used as JS string delimiters
// inside the big inline <script> in public/index.html, which threw
// "Uncaught SyntaxError: Invalid or unexpected token" and aborted the
// controller script so the app never booted (PR #33 / commit de34dda).
//
// U+2018 (LEFT SINGLE QUOTATION MARK) never legitimately appears in this
// file — it was only ever an autocorrected opening delimiter — so its
// presence is always the bug. (U+2019 is allowed: it shows up as a genuine
// apostrophe inside "…" strings/comments, e.g. "Couldn't".)
//
// Run with: node tests/test-no-smart-quotes.js

const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "public", "index.html");
const text = fs.readFileSync(file, "utf8");

const bad = [];
const lines = text.split("\n");
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("‘")) {
    bad.push(i + 1 + ": " + lines[i].trim());
  }
}

if (bad.length) {
  console.error(
    "FAIL: public/index.html contains U+2018 (‘) smart quotes — likely a " +
      "smart-quote autocorrect broke JS string delimiters. Offending lines:"
  );
  for (const b of bad) console.error("  " + b);
  process.exit(1);
}

console.log("OK: no U+2018 smart quotes in public/index.html");
