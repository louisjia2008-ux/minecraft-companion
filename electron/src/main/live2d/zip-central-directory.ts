const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const MAX_EOCD_SEARCH = 65_557;

export interface ZipCentralEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  directory: boolean;
  symlink: boolean;
}

const findEocd = (archive: Buffer): number => {
  const start = Math.max(0, archive.byteLength - MAX_EOCD_SEARCH);
  for (let offset = archive.byteLength - 22; offset >= start; offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('ZIP end-of-central-directory record is missing.');
};

export const parseZipCentralDirectory = (archive: Buffer): ZipCentralEntry[] => {
  const eocd = findEocd(archive);
  const entryCount = archive.readUInt16LE(eocd + 10);
  const directorySize = archive.readUInt32LE(eocd + 12);
  const directoryOffset = archive.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported.');
  }
  if (directoryOffset + directorySize > eocd) throw new Error('ZIP central directory is outside the archive.');

  const entries: ZipCentralEntry[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.byteLength || archive.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error('ZIP central directory entry is malformed.');
    }
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const nameStart = offset + 46;
    const nextOffset = nameStart + nameLength + extraLength + commentLength;
    if (nextOffset > archive.byteLength) throw new Error('ZIP central directory filename is truncated.');
    const name = archive.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const unixMode = externalAttributes >>> 16;
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      directory: name.endsWith('/'),
      symlink: (unixMode & 0o170000) === 0o120000,
    });
    offset = nextOffset;
  }
  if (offset !== directoryOffset + directorySize) throw new Error('ZIP central directory size does not match its records.');
  return entries;
};
