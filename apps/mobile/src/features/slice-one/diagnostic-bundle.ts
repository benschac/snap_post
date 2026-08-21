export type ZipEntry = {
  name: string;
  bytes: Uint8Array;
};

const CRC32_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Uint8Array) {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum = CRC32_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function writeUint16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, true);
}

function copyBytes(target: Uint8Array, offset: number, source: Uint8Array) {
  target.set(source, offset);
  return offset + source.length;
}

function validateEntryName(name: string) {
  if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) {
    throw new Error(`Invalid ZIP entry path: ${name}`);
  }
}

export function createStoredZip(entries: ZipEntry[]) {
  if (entries.length > 0xffff) throw new Error('ZIP contains too many files.');

  const encoder = new TextEncoder();
  const prepared = entries.map((entry) => {
    validateEntryName(entry.name);
    const name = encoder.encode(entry.name);
    if (name.length > 0xffff) throw new Error(`ZIP entry name is too long: ${entry.name}`);
    return { ...entry, checksum: crc32(entry.bytes), name };
  });
  const localSize = prepared.reduce((total, entry) => total + 30 + entry.name.length + entry.bytes.length, 0);
  const centralSize = prepared.reduce((total, entry) => total + 46 + entry.name.length, 0);
  const archive = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(archive.buffer);
  const offsets: number[] = [];
  let offset = 0;

  for (const entry of prepared) {
    offsets.push(offset);
    writeUint32(view, offset, 0x04034b50);
    writeUint16(view, offset + 4, 20);
    writeUint16(view, offset + 6, 0x0800);
    writeUint16(view, offset + 8, 0);
    writeUint16(view, offset + 10, 0);
    writeUint16(view, offset + 12, 0);
    writeUint32(view, offset + 14, entry.checksum);
    writeUint32(view, offset + 18, entry.bytes.length);
    writeUint32(view, offset + 22, entry.bytes.length);
    writeUint16(view, offset + 26, entry.name.length);
    writeUint16(view, offset + 28, 0);
    offset = copyBytes(archive, offset + 30, entry.name);
    offset = copyBytes(archive, offset, entry.bytes);
  }

  const centralOffset = offset;
  for (let index = 0; index < prepared.length; index += 1) {
    const entry = prepared[index];
    writeUint32(view, offset, 0x02014b50);
    writeUint16(view, offset + 4, 20);
    writeUint16(view, offset + 6, 20);
    writeUint16(view, offset + 8, 0x0800);
    writeUint16(view, offset + 10, 0);
    writeUint16(view, offset + 12, 0);
    writeUint16(view, offset + 14, 0);
    writeUint32(view, offset + 16, entry.checksum);
    writeUint32(view, offset + 20, entry.bytes.length);
    writeUint32(view, offset + 24, entry.bytes.length);
    writeUint16(view, offset + 28, entry.name.length);
    writeUint16(view, offset + 30, 0);
    writeUint16(view, offset + 32, 0);
    writeUint16(view, offset + 34, 0);
    writeUint16(view, offset + 36, 0);
    writeUint32(view, offset + 38, 0);
    writeUint32(view, offset + 42, offsets[index]);
    offset = copyBytes(archive, offset + 46, entry.name);
  }

  writeUint32(view, offset, 0x06054b50);
  writeUint16(view, offset + 4, 0);
  writeUint16(view, offset + 6, 0);
  writeUint16(view, offset + 8, prepared.length);
  writeUint16(view, offset + 10, prepared.length);
  writeUint32(view, offset + 12, centralSize);
  writeUint32(view, offset + 16, centralOffset);
  writeUint16(view, offset + 20, 0);

  return archive;
}
