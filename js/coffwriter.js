// coffwriter.js — generate COFF object (x86-64) from raw bytes
// Symbols: _binary_<name>_start, _binary_<name>_end, _binary_<name>_size

const MACHINE_AMD64 = 0x8664;
const IMAGE_SYM_CLASS_EXTERNAL = 2;
const IMAGE_SYM_ABSOLUTE = 0xffff;
const SECTION_INITIALIZED_DATA = 0x40000000;
const SECTION_MEM_READ = 0x40000000;

export function binaryToCoff(symbolName, data) {
  const pad4 = (n) => (n + 3) & ~3;
  const dataSize = data.length;
  const dataPadded = pad4(dataSize);

  const FILE_HEADER_SIZE = 20;
  const SECTION_HEADER_SIZE = 40;
  const SYMBOL_SIZE = 18;
  const NUM_SYMBOLS = 3;

  const dataOffset = FILE_HEADER_SIZE + SECTION_HEADER_SIZE;
  const symbolTableOffset = dataOffset + dataPadded;
  const symbolTableSize = NUM_SYMBOLS * SYMBOL_SIZE;

  const shortName = `_binary_${symbolName}`;
  const startName = shortName + "_start";
  const endName = shortName + "_end";
  const sizeName = shortName + "_size";

  const longNames = new Set();
  for (const n of [startName, endName, sizeName])
    if (n.length > 8) longNames.add(n);

  let stringTableContent = new Uint8Array(0);
  const longNameOffsets = new Map();

  if (longNames.size > 0) {
    const enc = new TextEncoder();
    const parts = [];
    let acc = 4;
    for (const n of longNames) {
      longNameOffsets.set(n, acc);
      const b = enc.encode(n);
      parts.push(b);
      parts.push(new Uint8Array([0]));
      acc += b.length + 1;
    }
    stringTableContent = new Uint8Array(acc);
    const dv = new DataView(stringTableContent.buffer);
    dv.setUint32(0, acc, true);
    let pos = 4;
    for (const b of parts) {
      stringTableContent.set(b, pos);
      pos += b.length;
    }
  }

  const totalSize =
    symbolTableOffset + symbolTableSize + stringTableContent.length;
  const out = new Uint8Array(totalSize);
  const dv = new DataView(out.buffer);

  dv.setUint16(0, MACHINE_AMD64, true);
  dv.setUint16(2, 1, true);
  dv.setUint32(4, 0, true);
  dv.setUint32(8, symbolTableOffset, true);
  dv.setUint32(12, NUM_SYMBOLS, true);
  dv.setUint16(16, 0, true);
  dv.setUint16(18, 0, true);

  const shOff = FILE_HEADER_SIZE;
  out.set(new TextEncoder().encode(".rdata\0\0"), shOff);
  dv.setUint32(shOff + 8, 0, true);
  dv.setUint32(shOff + 12, 0, true);
  dv.setUint32(shOff + 16, dataSize, true);
  dv.setUint32(shOff + 20, dataOffset, true);
  dv.setUint32(shOff + 24, 0, true);
  dv.setUint32(shOff + 28, 0, true);
  dv.setUint16(shOff + 32, 0, true);
  dv.setUint16(shOff + 34, 0, true);
  dv.setUint32(shOff + 36, SECTION_INITIALIZED_DATA | SECTION_MEM_READ, true);

  out.set(data, dataOffset);

  const symbols = [
    {
      name: startName,
      value: 0,
      section: 1,
      storage: IMAGE_SYM_CLASS_EXTERNAL,
    },
    {
      name: endName,
      value: dataSize,
      section: 1,
      storage: IMAGE_SYM_CLASS_EXTERNAL,
    },
    {
      name: sizeName,
      value: dataSize,
      section: IMAGE_SYM_ABSOLUTE,
      storage: IMAGE_SYM_CLASS_EXTERNAL,
    },
  ];

  let symOff = symbolTableOffset;
  for (const sym of symbols) {
    const enc = new TextEncoder().encode(sym.name);
    if (enc.length <= 8) out.set(enc, symOff);
    else {
      const strOff = longNameOffsets.get(sym.name);
      dv.setUint32(symOff + 4, strOff, true);
    }
    dv.setUint32(symOff + 8, sym.value, true);
    dv.setInt16(symOff + 12, sym.section, true);
    dv.setUint16(symOff + 14, 0, true);
    dv.setUint8(symOff + 16, sym.storage);
    dv.setUint8(symOff + 17, 0);
    symOff += SYMBOL_SIZE;
  }

  if (stringTableContent.length > 0) {
    out.set(stringTableContent, symbolTableOffset + symbolTableSize);
  }
  return out;
}

export function generateHeader(symbolName, fileName, dataLength) {
  const sym = `_binary_${symbolName}`;
  return `#pragma once
/* Auto-generated from ${fileName} (${dataLength} bytes) */

#ifdef __cplusplus
extern "C" {
#endif

extern const unsigned char ${sym}_start[];
extern const unsigned char ${sym}_end[];
extern const unsigned char ${sym}_size[];

#ifdef __cplusplus
}
#endif
`;
}
