/* Minimal ZIP builder (stored, no compression) for the "音声パック" download.
   WAV audio barely compresses, so storing is enough and keeps this dependency-free. */

const Zip = (() => {
  // Step 1: CRC-32 lookup table (required by the ZIP format)
  const TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
  }

  /** files: [{ name: string, data: Blob | string }] -> Blob (application/zip) */
  async function build(files) {
    const encoder = new TextEncoder();
    const { time, day } = dosDateTime(new Date());
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    let centralSize = 0;

    for (const file of files) {
      // Step 2: read the file bytes and compute its checksum
      const bytes = typeof file.data === "string"
        ? encoder.encode(file.data)
        : new Uint8Array(await file.data.arrayBuffer());
      const name = encoder.encode(file.name);
      const crc = crc32(bytes);

      // Step 3: local file header (30 bytes) + name + data
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 file names (Japanese)
      local.setUint16(8, 0, true);      // stored
      local.setUint16(10, time, true);
      local.setUint16(12, day, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, bytes.length, true);
      local.setUint32(22, bytes.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      localParts.push(local.buffer, name, bytes);

      // Step 4: matching central directory entry (46 bytes) + name
      const central = new DataView(new ArrayBuffer(46));
      central.setUint32(0, 0x02014b50, true);
      central.setUint16(4, 20, true);
      central.setUint16(6, 20, true);
      central.setUint16(8, 0x0800, true);
      central.setUint16(10, 0, true);
      central.setUint16(12, time, true);
      central.setUint16(14, day, true);
      central.setUint32(16, crc, true);
      central.setUint32(20, bytes.length, true);
      central.setUint32(24, bytes.length, true);
      central.setUint16(28, name.length, true);
      central.setUint32(42, offset, true);
      centralParts.push(central.buffer, name);

      offset += 30 + name.length + bytes.length;
      centralSize += 46 + name.length;
    }

    // Step 5: end of central directory record (22 bytes)
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...localParts, ...centralParts, end.buffer], { type: "application/zip" });
  }

  return { build };
})();
