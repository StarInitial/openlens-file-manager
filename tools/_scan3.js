const fs = require("node:fs");

const s = fs.readFileSync("node_modules/@k8slens/core/static/build/library/renderer.js", "utf8");

for (const needle of ["drawer-backdrop", "usePortal", "onClickOutside"]) {
  const i = s.indexOf(needle);
  console.log(`=== ${needle} @${i} ===`);
  if (i > 0) console.log(s.slice(Math.max(0, i - 600), i + 500).replace(/\s+/g, " "));
  console.log("");
}
