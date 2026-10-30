// Browser test of boot-storage hits. Serve docs/ on port 8771, then: node test/browser-storage.mjs
// Needs Playwright (npm i -D playwright) and a Chromium; set CHROME to its path if not bundled.
import { chromium } from "playwright";
const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const p = await b.newPage({ viewport: { width: 420, height: 1400 } });
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
const t0 = Date.now(); const T = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(4) + "s";
const v = async (id) => (await p.textContent("#" + id)).replace(/\s+/g, " ").trim();
const until = (re, id = "status", ms = 120000) => p.waitForFunction(([r, i]) => new RegExp(r).test(document.getElementById(i).textContent), [re, id], { timeout: ms });
const cycle = async () => { await p.click("#st-cycle"); await until("booting|LOOP", "status", 15000); };
const hit = async (file, off, bit) => { await p.selectOption("#st-file", file); await p.fill("#st-off", String(off)); await p.selectOption("#st-bit", String(bit)); await p.click("#st-hit"); };
const con = () => p.evaluate(() => document.getElementById("con").textContent);
const lastEvents = async (n) => (await v("evt")).split(" [").slice(-n).join("\n   [");

await p.goto("http://127.0.0.1:8771/");
await until("OPERATIONAL"); console.log(T(), "boot 1:", await v("status"), "| wd:", await v("wd-state"));
console.log("      files in storage:", await p.evaluate(() => storage.files.length), "| diff bits:", await v("st-diff"));

// A: unused duplicate library
await hit("lib/libc.so.6", 0, 0);
console.log(T(), "A hit unused lib/libc.so.6; still running:", await v("status"), "| diff:", await v("st-diff"));
await cycle(); await until("OPERATIONAL");
console.log(T(), "A after power cycle:", await v("status"), "| boots", await v("boots"));

// B: one app's file
await p.click("#st-restore");
await hit("cfs/cpu1/cf/sample_app.so", 0, 0);
await cycle(); await until("OPERATIONAL"); await p.waitForTimeout(4000);
const cB = await con();
console.log(T(), "B sample_app.so hit:", await v("status"), "| console mentions SAMPLE_APP error:", /SAMPLE_APP|sample_app/.test(cB.split("FSW-AUTOSTART").pop()));
console.log("      console:", cB.split("FSW-AUTOSTART").pop().replace(/\s+/g, " ").slice(0, 400));

// C: the cFS executable itself -> boot loop
await p.click("#st-restore");
await hit("cfs/cpu1/core-cpu1", 0, 0);
await cycle();
await p.waitForTimeout(12000);
await until("could not start", "status", 20000).catch(() => {});
console.log(T(), "C core-cpu1 hit:", await v("status"), "| wd:", await v("wd-state"), await v("wd-kick"));
console.log("      console tail:", (await con()).split("FSW-AUTOSTART").pop().replace(/\s+/g, " ").slice(0, 200));
await until("BOOT LOOP", "status", 120000);
console.log(T(), "C:", await v("status"), "| resets", await v("wd-resets"), "| fails in a row", await v("fails"));

// D: ground restores storage; next watchdog reset boots clean
await p.click("#st-restore");
await until("OPERATIONAL", "status", 120000);
console.log(T(), "D after restore:", await v("status"), "| fails in a row", await v("fails"), "| diff", await v("st-diff"));

// E: exploratory kernel hit
await hit("kernel", 20000, 3);
await cycle();
await until("OPERATIONAL|LOOP|panic", "status", 150000).catch(() => {});
console.log(T(), "E kernel+20000 bit3:", await v("status"), "| wd:", await v("wd-state"));
console.log("      events:\n   [" + await lastEvents(4));
console.log("page errors:", errs.length ? errs : "none");
await b.close();
