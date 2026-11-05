// Exhaustive check of the SECDED decoder: all 1-, 2- and 3-bit errors in a 64-bit word
import { decode, DATA_POS } from "../docs/js/ecc.js";
const e = (...bits) => { const a = new Uint8Array(8); for (const b of bits) a[b >> 3] ^= 1 << (b & 7); return a; };
let ok = 0, bad = 0; const t = (n, c) => { c ? ok++ : (bad++, console.log("FAIL", n)); };
t("64 positions", DATA_POS.length === 64 && DATA_POS[63] === 71);
for (let i = 0; i < 64; i++) t("single " + i, decode(e(i)).kind === "corrected");
let det = 0; for (let i = 0; i < 64; i++) for (let j = i + 1; j < 64; j++) det += decode(e(i, j)).kind === "detected"; t("all doubles detected", det === 2016);
const tri = { corrected: 0, detected: 0, silent: 0 }; for (let i = 0; i < 64; i++) for (let j = i + 1; j < 64; j++) for (let k = j + 1; k < 64; k++) tri[decode(e(i, j, k)).kind]++;
console.log("triples:", tri, "doubles detected", det); console.log(ok, "pass", bad, "fail");
