// SECDED ECC on 64-bit words: an extended Hamming (72,64) code, the kind of code
// a memory controller stores next to every 8 bytes of DRAM (8 check bits).
//
// Data bit i of a word sits at Hamming position DATA_POS[i] (every number from 3
// to 71 that is not a power of two; powers of two are the check bits). Flipping a
// set of data bits gives a syndrome = XOR of their positions, plus an overall
// parity that is odd when an odd number of bits flipped. The decoder then:
//   odd parity,  syndrome = a data position  -> flips that bit back ("corrects")
//   odd parity,  syndrome = 0 or a check-bit position -> blames a check bit, data untouched
//   odd parity,  syndrome > 71               -> detected, uncorrectable
//   even parity, syndrome != 0               -> detected, uncorrectable (double error)
//   even parity, syndrome = 0                -> sees nothing
// With one flipped bit that is always right. With three or more it can "correct"
// the wrong bit or miss the error: silent corruption, exactly as real SECDED does.

export const WORD = 8;   // bytes covered by one set of check bits

export const DATA_POS = (() => {
  const out = [];
  for (let p = 3; out.length < 64; p++) if (p & (p - 1)) out.push(p);
  return out;
})();
const POS_TO_BIT = new Map(DATA_POS.map((p, i) => [p, i]));

// e: Uint8Array(8), the bits that differ from what was written (byte 0 = lowest address)
// returns { kind, residual }:
//   kind: "clean" | "corrected" | "detected" | "silent"
//   residual: Uint8Array(8) of bits still wrong after the decoder acted (what the CPU reads wrong)
export function decode(e) {
  let syn = 0, weight = 0;
  for (let i = 0; i < 64; i++) if (e[i >> 3] & (1 << (i & 7))) { syn ^= DATA_POS[i]; weight++; }
  const residual = Uint8Array.from(e);
  if (weight === 0) return { kind: "clean", residual };
  if (weight % 2 === 0) return syn ? { kind: "detected", residual } : { kind: "silent", residual };
  if (syn > 71) return { kind: "detected", residual };
  const bit = POS_TO_BIT.get(syn);
  if (bit !== undefined) residual[bit >> 3] ^= 1 << (bit & 7);   // the decoder flips what it believes is wrong
  const left = residual.some((x) => x);
  return { kind: left ? "silent" : "corrected", residual };
}

export const bitsSet = (e) => { let n = 0; for (const v of e) for (let x = v; x; x >>= 1) n += x & 1; return n; };
