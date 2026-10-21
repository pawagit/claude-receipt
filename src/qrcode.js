// Zero-dependency QR Code generator (byte mode) + inline-SVG renderer.
//
// The encoding core is a compact port of Project Nayuki's "QR Code generator"
// reference implementation (MIT License, https://www.nayuki.io/page/qr-code-generator-library)
// to plain ESM JavaScript. It supports versions 1-40, all four error-correction
// levels, byte-mode segments, automatic version selection, and optimal data
// masking — i.e. real, scannable QR codes, not a decorative mock-up.
//
// Public API:
//   encodeText(text, { ecl })  -> { size, modules }  (modules: boolean[][], true = dark)
//   renderQrSvg(text, opts)    -> string of inline <svg> markup

// --- Error-correction level -------------------------------------------------
// ordinal: index into the tables below; formatBits: 2-bit field stored in the QR.
export const Ecc = {
  LOW: { ordinal: 0, formatBits: 1 },
  MEDIUM: { ordinal: 1, formatBits: 0 },
  QUARTILE: { ordinal: 2, formatBits: 3 },
  HIGH: { ordinal: 3, formatBits: 2 },
};

const MIN_VERSION = 1;
const MAX_VERSION = 40;
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

// Number of error-correction codewords per block, indexed [ecl.ordinal][version].
// Index 0 of each row is unused padding (-1).
const ECC_CODEWORDS_PER_BLOCK = [
  // 0   1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30  31  32  33  34  35  36  37  38  39  40
  [-1,  7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Low
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // Medium
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Quartile
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // High
];

// Number of error-correction blocks, indexed [ecl.ordinal][version].
const NUM_ERROR_CORRECTION_BLOCKS = [
  // 0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // Low
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // Medium
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Quartile
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // High
];

// --- Reed-Solomon over GF(2^8) with primitive modulus 0x11D ----------------
function reedSolomonMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function reedSolomonComputeDivisor(degree) {
  if (degree < 1 || degree > 255) throw new RangeError('Degree out of range');
  const result = [];
  for (let i = 0; i < degree - 1; i++) result.push(0);
  result.push(1); // start as monomial x^0
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = reedSolomonMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = reedSolomonMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonComputeRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= reedSolomonMultiply(coef, factor);
    });
  }
  return result;
}

// --- Version / capacity math ------------------------------------------------
function getNumRawDataModules(ver) {
  if (ver < MIN_VERSION || ver > MAX_VERSION) throw new RangeError('Version out of range');
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function getNumDataCodewords(ver, ecl) {
  return (
    Math.floor(getNumRawDataModules(ver) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver]
  );
}

// --- Bit buffer + byte-mode segment ----------------------------------------
function appendBits(val, len, bb) {
  if (len < 0 || len > 31 || val >>> len !== 0) throw new RangeError('Value out of range');
  for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
}

function utf8Bytes(str) {
  // TextEncoder never throws: a lone surrogate becomes U+FFFD, where
  // encodeURIComponent would raise a URIError and sink the whole receipt.
  return Array.from(new TextEncoder().encode(str));
}

// --- Public: encode text into a QR module matrix ---------------------------
export function encodeText(text, { ecl = Ecc.MEDIUM } = {}) {
  const data = utf8Bytes(text);

  // Choose the smallest version that fits the data at the requested ECC level.
  let version = MIN_VERSION;
  let dataUsedBits = 0;
  for (; ; version++) {
    if (version > MAX_VERSION) throw new RangeError('Data too long for any QR version');
    const dataCapacityBits = getNumDataCodewords(version, ecl) * 8;
    const ccBits = version < 10 ? 8 : 16; // byte-mode character-count width
    const usedBits = 4 + ccBits + data.length * 8;
    if (usedBits <= dataCapacityBits) {
      dataUsedBits = usedBits;
      break;
    }
  }

  // Build the bit stream: mode indicator (byte=0100), char count, payload.
  const bb = [];
  appendBits(0x4, 4, bb);
  appendBits(data.length, version < 10 ? 8 : 16, bb);
  for (const b of data) appendBits(b, 8, bb);

  // Terminator + bit/byte padding up to capacity.
  const dataCapacityBits = getNumDataCodewords(version, ecl) * 8;
  appendBits(0, Math.min(4, dataCapacityBits - bb.length), bb);
  appendBits(0, (8 - (bb.length % 8)) % 8, bb);
  for (let pad = 0xec; bb.length < dataCapacityBits; pad ^= 0xec ^ 0x11) appendBits(pad, 8, bb);

  // Pack bits into codeword bytes.
  const dataCodewords = [];
  for (let i = 0; i < bb.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bb[i + j];
    dataCodewords.push(byte);
  }

  const allCodewords = addEccAndInterleave(dataCodewords, version, ecl);
  return new QrCode(version, ecl, allCodewords).toMatrix();
}

// Compute ECC for each block and interleave data+ECC codewords.
function addEccAndInterleave(data, version, ecl) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][version];
  const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks = [];
  const rsDiv = reedSolomonComputeDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = reedSolomonComputeRemainder(dat, rsDiv);
    if (i < numShortBlocks) dat.push(0); // pad short blocks to align interleaving
    blocks.push(dat.concat(ecc));
  }

  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      // Skip the padding cell that short blocks don't actually have.
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

// --- QR symbol: lay out modules, apply best mask ---------------------------
class QrCode {
  constructor(version, ecl, codewords) {
    this.version = version;
    this.ecl = ecl;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false));

    this.drawFunctionPatterns();
    this.drawCodewords(codewords);

    // Try all 8 masks, keep the one with the lowest penalty score.
    let minPenalty = Infinity;
    let bestMask = 0;
    let bestModules = null;
    for (let mask = 0; mask < 8; mask++) {
      this.applyMask(mask);
      this.drawFormatBits(mask);
      const penalty = this.getPenaltyScore();
      if (penalty < minPenalty) {
        minPenalty = penalty;
        bestMask = mask;
        bestModules = this.modules.map((row) => row.slice());
      }
      this.applyMask(mask); // XOR again to undo before trying the next mask
    }
    this.mask = bestMask;
    this.modules = bestModules;
    this.drawFormatBits(bestMask);
  }

  toMatrix() {
    return { size: this.size, modules: this.modules };
  }

  // --- Function patterns ----------------------------------------------------
  drawFunctionPatterns() {
    // Timing patterns
    for (let i = 0; i < this.size; i++) {
      this.setFunctionModule(6, i, i % 2 === 0);
      this.setFunctionModule(i, 6, i % 2 === 0);
    }
    // Finder patterns (3 corners) + their separators
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(this.size - 4, 3);
    this.drawFinderPattern(3, this.size - 4);

    // Alignment patterns
    const alignPos = this.getAlignmentPatternPositions();
    const numAlign = alignPos.length;
    for (let i = 0; i < numAlign; i++) {
      for (let j = 0; j < numAlign; j++) {
        // Skip the three corners occupied by finder patterns.
        if (!((i === 0 && j === 0) || (i === 0 && j === numAlign - 1) || (i === numAlign - 1 && j === 0)))
          this.drawAlignmentPattern(alignPos[i], alignPos[j]);
      }
    }

    // Reserve format + version areas (filled with real bits later).
    this.drawFormatBits(0);
    this.drawVersion();
  }

  drawFormatBits(mask) {
    const data = (this.ecl.formatBits << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;

    // First copy (around top-left finder)
    for (let i = 0; i <= 5; i++) this.setFunctionModule(8, i, getBit(bits, i));
    this.setFunctionModule(8, 7, getBit(bits, 6));
    this.setFunctionModule(8, 8, getBit(bits, 7));
    this.setFunctionModule(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, getBit(bits, i));

    // Second copy (split between the other two finders)
    for (let i = 0; i < 8; i++) this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i));
    this.setFunctionModule(8, this.size - 8, true); // always-dark module
  }

  drawVersion() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;

    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunctionModule(a, b, bit);
      this.setFunctionModule(b, a, bit);
    }
  }

  drawFinderPattern(x, y) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy)); // Chebyshev distance
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size)
          this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }

  drawAlignmentPattern(x, y) {
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++)
        this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }

  setFunctionModule(x, y, isDark) {
    this.modules[y][x] = isDark;
    this.isFunction[y][x] = true;
  }

  getAlignmentPatternPositions() {
    if (this.version === 1) return [];
    const numAlign = Math.floor(this.version / 7) + 2;
    const step =
      this.version === 32 ? 26 : Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  // --- Data codewords -------------------------------------------------------
  drawCodewords(data) {
    let i = 0; // bit index into the data
    // Walk up/down in 2-module-wide columns, right to left, skipping col 6.
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  applyMask(mask) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.isFunction[y][x]) continue;
        let invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: throw new RangeError('Bad mask');
        }
        if (invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  getPenaltyScore() {
    let result = 0;
    const size = this.size;
    const mods = this.modules;

    // Rule 1: runs of 5+ same-colour modules in rows and columns.
    for (let y = 0; y < size; y++) {
      let runColor = false;
      let runX = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < size; x++) {
        if (mods[y][x] === runColor) {
          runX++;
          if (runX === 5) result += PENALTY_N1;
          else if (runX > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runX, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          runColor = mods[y][x];
          runX = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * PENALTY_N3;
    }
    for (let x = 0; x < size; x++) {
      let runColor = false;
      let runY = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < size; y++) {
        if (mods[y][x] === runColor) {
          runY++;
          if (runY === 5) result += PENALTY_N1;
          else if (runY > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runY, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          runColor = mods[y][x];
          runY = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runY, runHistory) * PENALTY_N3;
    }

    // Rule 2: 2x2 blocks of the same colour.
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const color = mods[y][x];
        if (color === mods[y][x + 1] && color === mods[y + 1][x] && color === mods[y + 1][x + 1])
          result += PENALTY_N2;
      }
    }

    // Rule 4: balance of dark vs. light modules.
    let dark = 0;
    for (const row of mods) for (const v of row) if (v) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;
    return result;
  }

  finderPenaltyCountPatterns(runHistory) {
    const n = runHistory[1];
    const core =
      n > 0 &&
      runHistory[2] === n &&
      runHistory[3] === n * 3 &&
      runHistory[4] === n &&
      runHistory[5] === n;
    return (
      (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) +
      (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0)
    );
  }

  finderPenaltyTerminateAndCount(currentRunColor, currentRunLength, runHistory) {
    if (currentRunColor) {
      this.finderPenaltyAddHistory(currentRunLength, runHistory);
      currentRunLength = 0;
    }
    currentRunLength += this.size; // add light border to final run
    this.finderPenaltyAddHistory(currentRunLength, runHistory);
    return this.finderPenaltyCountPatterns(runHistory);
  }

  finderPenaltyAddHistory(currentRunLength, runHistory) {
    if (runHistory[0] === 0) currentRunLength += this.size; // add light border to first run
    runHistory.pop();
    runHistory.unshift(currentRunLength);
  }
}

function getBit(x, i) {
  return ((x >>> i) & 1) !== 0;
}

// --- Inline-SVG renderer ----------------------------------------------------
// Renders the QR as a single <path> of dark modules over a light background,
// with a quiet-zone border. Self-contained: no external requests, scales crisply.
export function renderQrSvg(text, { ecl = Ecc.MEDIUM, border = 4, dark = '#1a1a1a', light = 'transparent', className = '', title = '' } = {}) {
  const { size, modules } = encodeText(text, { ecl });
  const dim = size + border * 2;

  let path = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) path += `M${x + border} ${y + border}h1v1h-1z`;
    }
  }

  const cls = className ? ` class="${className}"` : '';
  const titleEl = title ? `<title>${title.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</title>` : '';
  return (
    `<svg${cls} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR code of the receipt details">` +
    `${titleEl}` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/>` +
    `</svg>`
  );
}
