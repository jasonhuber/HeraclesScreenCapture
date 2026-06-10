const ZIP_CRC_TABLE = createCrc32Table();

export async function buildZipBlob(files) {
  const zipParts = [];
  const centralDirectory = [];
  let offset = 0;

  for (const file of files) {
    const fileNameBytes = new TextEncoder().encode(file.path);
    const fileBytes = new Uint8Array(await file.blob.arrayBuffer());
    const crc = crc32(fileBytes);
    const dosDateTime = toDosDateTime(file.date || new Date());

    const localHeader = new Uint8Array(30 + fileNameBytes.length);
    let view = new DataView(localHeader.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, dosDateTime.time, true);
    view.setUint16(12, dosDateTime.date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, fileBytes.length, true);
    view.setUint32(22, fileBytes.length, true);
    view.setUint16(26, fileNameBytes.length, true);
    view.setUint16(28, 0, true);
    localHeader.set(fileNameBytes, 30);

    zipParts.push(localHeader, fileBytes);

    const centralHeader = new Uint8Array(46 + fileNameBytes.length);
    view = new DataView(centralHeader.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, dosDateTime.time, true);
    view.setUint16(14, dosDateTime.date, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, fileBytes.length, true);
    view.setUint32(24, fileBytes.length, true);
    view.setUint16(28, fileNameBytes.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, offset, true);
    centralHeader.set(fileNameBytes, 46);

    centralDirectory.push(centralHeader);
    offset += localHeader.length + fileBytes.length;
  }

  const centralSize = centralDirectory.reduce((sum, part) => sum + part.length, 0);
  const centralOffset = offset;
  zipParts.push(...centralDirectory);

  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  endView.setUint16(20, 0, true);

  zipParts.push(endRecord);
  return new Blob(zipParts, { type: "application/zip" });
}

function toDosDateTime(date) {
  const safeDate = new Date(date);
  const year = Math.max(1980, safeDate.getFullYear());
  const month = safeDate.getMonth() + 1;
  const day = safeDate.getDate();
  const hours = safeDate.getHours();
  const minutes = safeDate.getMinutes();
  const seconds = Math.floor(safeDate.getSeconds() / 2);

  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day
  };
}

function crc32(bytes) {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = ZIP_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function createCrc32Table() {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }

    table[index] = value >>> 0;
  }

  return table;
}
