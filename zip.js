/*
 * Pixel Veil - zip.js
 *
 * A small ZIP writer for saving several photos as one download. A classic script in
 * one IIFE, with no dependencies. Nothing here talks to the network.
 *
 * Files are stored, not compressed: JPEG and PNG are compressed already, so there is
 * nothing to gain. The archive is assembled from Blob parts. Each photo's Blob goes into
 * the archive by reference, so the only extra memory is one small header per file, plus
 * one chunk at a time while a file's checksum is worked out.
 *
 * Public interface (the only global this file creates):
 *
 *   window.PixelVeilZip = {
 *     create()                 // -> a new, empty archive:
 *   };
 *
 *   archive.add(name, blob)    // -> Promise, resolved once the file is in the archive
 *   archive.finish()           // -> Blob (application/zip) of everything added so far
 *   archive.size               // bytes of headers and file data so far, 0 when empty
 *   archive.count              // files so far
 *   archive.has(name)          // true if a name is taken (ignores upper and lower case)
 *
 * This is the classic ZIP format, without ZIP64, so every program can open it. That
 * format stops at 4 GB and 65,535 files. add() rejects with an Error before it reads
 * anything when a file does not fit, and the archive is left as it was. error.code says
 * why: 'ZIP_ARCHIVE_FULL' and 'ZIP_TOO_MANY_ENTRIES' mean "finish this archive and start
 * another", 'ZIP_ENTRY_TOO_LARGE' means the file can never go in a ZIP of this kind.
 * The other codes are 'ZIP_BAD_NAME', 'ZIP_DUPLICATE_NAME', 'ZIP_BAD_DATA' and
 * 'ZIP_BUSY'.
 *
 * In Node (for tests) the same object is module.exports.
 */
(function () {
  'use strict';

  /* ======================================================================
   * Pure helpers. No Blob and no DOM in this block, so the checksum and the
   * header layout can be tested in Node.
   * ==================================================================== */
  /* @pure-begin */

  // The classic format keeps sizes and offsets in 32 bits and counts in 16 bits. The
  // all-ones value in a 32-bit field means "look in the ZIP64 record", so it is not usable.
  const ZIP_MAX_ENTRIES = 0xffff;
  const ZIP_MAX_ENTRY_BYTES = 0xfffffffe;
  const ZIP_MAX_ARCHIVE_BYTES = 0xffffffff;
  const ZIP_MAX_NAME_BYTES = 0xffff;

  const ZIP_LOCAL_HEADER_BYTES = 30;
  const ZIP_CENTRAL_HEADER_BYTES = 46;
  const ZIP_END_RECORD_BYTES = 22;

  const ZIP_VERSION = 20; // 2.0, the lowest version every reader accepts for a stored file
  const ZIP_FLAG_UTF8 = 0x0800; // general purpose bit 11: the name is UTF-8
  const ZIP_METHOD_STORE = 0;

  // CRC-32 as used by ZIP, PNG and gzip (polynomial 0xEDB88320, reflected).
  // Signed 32-bit entries keep the inner loop in small-integer arithmetic.
  const CRC_TABLE = (function () {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    return table;
  })();

  /**
   * CRC-32 of `bytes` (a Uint8Array). To checksum data that arrives in pieces, pass the
   * result for the earlier pieces as `crc`. Returns an unsigned 32-bit number.
   */
  function crc32(bytes, crc) {
    let c = ~(crc || 0);
    for (let i = 0, n = bytes.length; i < n; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return ~c >>> 0;
  }

  /** A file name as UTF-8 bytes. */
  function utf8Bytes(text) {
    return new TextEncoder().encode(String(text));
  }

  /**
   * Why a name cannot be used in an archive, or '' when it can. Names that would land
   * outside the folder the archive is unpacked into are refused.
   */
  function nameProblem(name) {
    if (typeof name !== 'string' || name === '') return 'the file name is empty';
    if (/[\u0000-\u001f\u007f]/.test(name)) return 'the file name has a control character in it';
    if (name.indexOf('\\') !== -1) return 'the file name has a backslash in it';
    if (name[0] === '/') return 'the file name starts with a slash';
    if (name.split('/').some((part) => part === '..' || part === '.' || part === '')) {
      return 'the file name has an empty, "." or ".." folder in it';
    }
    if (utf8Bytes(name).length > ZIP_MAX_NAME_BYTES) return 'the file name is too long';
    return '';
  }

  /**
   * Whether one more file fits in a classic archive. `count`, `dataBytes` and
   * `centralBytes` describe the archive so far (files, local headers plus file data,
   * and its central directory). Returns '' when it fits, otherwise an error code.
   */
  function fitProblem(count, dataBytes, centralBytes, nameLength, fileBytes) {
    if (fileBytes > ZIP_MAX_ENTRY_BYTES) return 'ZIP_ENTRY_TOO_LARGE';
    if (count + 1 > ZIP_MAX_ENTRIES) return 'ZIP_TOO_MANY_ENTRIES';
    const total =
      dataBytes + ZIP_LOCAL_HEADER_BYTES + nameLength + fileBytes +
      centralBytes + ZIP_CENTRAL_HEADER_BYTES + nameLength +
      ZIP_END_RECORD_BYTES;
    if (total > ZIP_MAX_ARCHIVE_BYTES) return 'ZIP_ARCHIVE_FULL';
    return '';
  }

  /**
   * A Date as the two 16-bit MS-DOS fields ZIP uses: local time, two-second steps,
   * years 1980 to 2107. Anything outside that range is pinned to the nearest end.
   */
  function dosDateTime(when) {
    const year = when.getFullYear();
    if (!(year >= 1980)) return { time: 0, date: (1 << 5) | 1 };
    if (year > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 };
    return {
      time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
    };
  }

  // An entry is { nameBytes, crc, size, time, date, offset }. All numbers are little-endian.

  /** The header that sits directly in front of a file's bytes. */
  function localHeader(entry) {
    const nameLength = entry.nameBytes.length;
    const bytes = new Uint8Array(ZIP_LOCAL_HEADER_BYTES + nameLength);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x04034b50, true); // "PK\3\4"
    view.setUint16(4, ZIP_VERSION, true); // version needed to extract
    view.setUint16(6, ZIP_FLAG_UTF8, true);
    view.setUint16(8, ZIP_METHOD_STORE, true);
    view.setUint16(10, entry.time, true);
    view.setUint16(12, entry.date, true);
    view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.size, true); // compressed size: the same, nothing is compressed
    view.setUint32(22, entry.size, true); // uncompressed size
    view.setUint16(26, nameLength, true);
    view.setUint16(28, 0, true); // extra field length
    bytes.set(entry.nameBytes, ZIP_LOCAL_HEADER_BYTES);
    return bytes;
  }

  /** The same file's record in the central directory at the end of the archive. */
  function centralHeader(entry) {
    const nameLength = entry.nameBytes.length;
    const bytes = new Uint8Array(ZIP_CENTRAL_HEADER_BYTES + nameLength);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x02014b50, true); // "PK\1\2"
    view.setUint16(4, ZIP_VERSION, true); // version made by (high byte 0: plain attributes)
    view.setUint16(6, ZIP_VERSION, true); // version needed to extract
    view.setUint16(8, ZIP_FLAG_UTF8, true);
    view.setUint16(10, ZIP_METHOD_STORE, true);
    view.setUint16(12, entry.time, true);
    view.setUint16(14, entry.date, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.size, true);
    view.setUint32(24, entry.size, true);
    view.setUint16(28, nameLength, true);
    view.setUint16(30, 0, true); // extra field length
    view.setUint16(32, 0, true); // comment length
    view.setUint16(34, 0, true); // disk number
    view.setUint16(36, 0, true); // internal attributes
    view.setUint32(38, 0, true); // external attributes
    view.setUint32(42, entry.offset, true); // where the local header starts
    bytes.set(entry.nameBytes, ZIP_CENTRAL_HEADER_BYTES);
    return bytes;
  }

  /** The record that closes the archive and points at the central directory. */
  function endRecord(count, centralBytes, centralOffset) {
    const bytes = new Uint8Array(ZIP_END_RECORD_BYTES);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x06054b50, true); // "PK\5\6"
    view.setUint16(4, 0, true); // this disk
    view.setUint16(6, 0, true); // disk with the central directory
    view.setUint16(8, count, true); // entries on this disk
    view.setUint16(10, count, true); // entries in total
    view.setUint32(12, centralBytes, true);
    view.setUint32(16, centralOffset, true);
    view.setUint16(20, 0, true); // comment length
    return bytes;
  }

  /* @pure-end */

  /* ======================================================================
   * The archive
   * ==================================================================== */

  // A file's checksum is worked out this many bytes at a time, so a large photo is
  // never copied into memory whole and the page stays responsive between chunks.
  const CHUNK_BYTES = 2 * 1024 * 1024;

  const MESSAGES = {
    ZIP_ENTRY_TOO_LARGE: 'is larger than 4 GB, which a ZIP file cannot hold',
    ZIP_TOO_MANY_ENTRIES: 'does not fit: a ZIP file holds at most 65,535 files. Start another archive',
    ZIP_ARCHIVE_FULL: 'does not fit: a ZIP file holds at most 4 GB. Start another archive',
  };

  function zipError(code, message) {
    const error = new Error('ZIP: ' + message);
    error.name = 'ZipError';
    error.code = code;
    return error;
  }

  function isBlobLike(value) {
    return (
      value !== null &&
      typeof value === 'object' &&
      typeof value.size === 'number' &&
      typeof value.slice === 'function'
    );
  }

  async function crc32OfBlob(blob) {
    let crc = 0;
    let done = 0;
    while (done < blob.size) {
      const chunk = new Uint8Array(await blob.slice(done, done + CHUNK_BYTES).arrayBuffer());
      if (chunk.length === 0) break;
      crc = crc32(chunk, crc);
      done += chunk.length;
    }
    if (done !== blob.size) {
      throw zipError('ZIP_BAD_DATA', 'a file could not be read to the end (' + done + ' of ' + blob.size + ' bytes).');
    }
    return crc;
  }

  function create() {
    const parts = []; // local header, file Blob, local header, file Blob, …
    const central = []; // one central directory record per file
    const names = new Set(); // lower-cased, to catch names that clash on Windows and macOS
    let dataBytes = 0; // length of everything in `parts`
    let centralBytes = 0; // length of everything in `central`
    let pending = 0; // add() calls that have not settled
    let tail = Promise.resolve(); // add() calls run one after another, in call order

    async function addEntry(name, blob) {
      const problem = nameProblem(name);
      if (problem) throw zipError('ZIP_BAD_NAME', problem + '.');
      if (!isBlobLike(blob)) throw zipError('ZIP_BAD_DATA', '"' + name + '" was not given as a Blob.');
      if (names.has(name.toLowerCase())) {
        throw zipError('ZIP_DUPLICATE_NAME', 'there is already a file called "' + name + '" in this archive.');
      }

      const nameBytes = utf8Bytes(name);
      const size = blob.size;
      const code = fitProblem(central.length, dataBytes, centralBytes, nameBytes.length, size);
      if (code) throw zipError(code, '"' + name + '" ' + MESSAGES[code] + '.');

      // Nothing is changed until the checksum is known, so a failed read leaves the
      // archive exactly as it was.
      const crc = await crc32OfBlob(blob);
      const stamp = dosDateTime(new Date());
      const entry = { nameBytes: nameBytes, crc: crc, size: size, time: stamp.time, date: stamp.date, offset: dataBytes };

      const header = localHeader(entry);
      parts.push(header, blob);
      dataBytes += header.length + size;

      const record = centralHeader(entry);
      central.push(record);
      centralBytes += record.length;
      names.add(name.toLowerCase());
    }

    return {
      /** Add one file. Resolves when it is in the archive, rejects (see the top of this file) when it is not. */
      add(name, blob) {
        pending++;
        const run = tail.then(() => addEntry(name, blob));
        tail = run.then(
          () => { pending--; },
          () => { pending--; }
        );
        return run;
      },

      /** The archive as a Blob. More files can still be added afterwards, for a later finish(). */
      finish() {
        if (pending > 0) {
          throw zipError('ZIP_BUSY', 'finish() was called while add() was still working. Wait for add() first.');
        }
        return new Blob(parts.concat(central, [endRecord(central.length, centralBytes, dataBytes)]), {
          type: 'application/zip',
        });
      },

      /** True if add() would refuse this name as a duplicate. */
      has(name) {
        return names.has(String(name).toLowerCase());
      },

      /** Bytes of headers and file data so far. finish() adds about 100 bytes per file to this. */
      get size() {
        return dataBytes;
      },

      /** Files in the archive so far. */
      get count() {
        return central.length;
      },
    };
  }

  const api = {
    create: create,
    // For tests only.
    _test: {
      crc32: crc32,
      utf8Bytes: utf8Bytes,
      nameProblem: nameProblem,
      fitProblem: fitProblem,
      dosDateTime: dosDateTime,
      localHeader: localHeader,
      centralHeader: centralHeader,
      endRecord: endRecord,
    },
  };

  if (typeof window !== 'undefined') window.PixelVeilZip = api;
  if (typeof module === 'object' && module !== null && typeof module.exports === 'object') module.exports = api;
})();
