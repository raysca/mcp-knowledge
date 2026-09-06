import AdmZip from "adm-zip";

export type ArchiveEntry = {
  path: string;
  declaredUncompressedBytes: number;
  declaredCompressedBytes: number;
  isDirectory: boolean;
  isSymlink: boolean;
};

export interface ArchiveReader {
  entries(): ArchiveEntry[];
  read(path: string, maxBytes: number): Uint8Array;
}

// Unix file-type bits within a zip entry's external attributes, per the zip spec's
// (ab)use of the upper 16 bits for Unix st_mode when the archive was made on Unix.
const UNIX_MODE_MASK = 0o170000;
const UNIX_SYMLINK_MODE = 0o120000;

export class AdmZipArchiveReader implements ArchiveReader {
  private readonly zip: InstanceType<typeof AdmZip>;

  constructor(bytes: Uint8Array) {
    this.zip = new AdmZip(Buffer.from(bytes));
  }

  entries(): ArchiveEntry[] {
    return this.zip
      .getEntries()
      .filter((entry) => !entry.isDirectory)
      .map((entry) => {
        const unixMode = (entry.header.attr >>> 16) & 0xffff;
        return {
          path: entry.entryName,
          declaredUncompressedBytes: entry.header.size,
          declaredCompressedBytes: entry.header.compressedSize,
          isDirectory: entry.isDirectory,
          isSymlink: (unixMode & UNIX_MODE_MASK) === UNIX_SYMLINK_MODE,
        };
      });
  }

  read(path: string, maxBytes: number): Uint8Array {
    const entry = this.zip.getEntry(path);
    if (!entry) throw new Error(`archive entry not found: ${path}`);
    // ponytail: adm-zip's getData() fully materializes the decompressed entry in memory
    // before this length check can reject it - a central-directory size that lies small
    // but inflates huge still costs the memory spike first. MAX_ARCHIVE_COMPRESSION_RATIO
    // (checked by the caller from declared header sizes alone, before this is ever called)
    // already rejects the classic bomb case - extreme but *honestly declared* compression.
    // Upgrade to a streaming zlib.createInflateRaw() with a hard byte-count cap if a
    // hostile (lying) central directory becomes a real threat model, not just this.
    const data = entry.getData();
    if (data.byteLength > maxBytes) {
      throw new Error(`archive entry exceeds declared size: ${path}`);
    }
    return new Uint8Array(data);
  }
}
