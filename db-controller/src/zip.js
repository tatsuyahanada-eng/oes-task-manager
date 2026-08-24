'use strict';

/**
 * 最小限の ZIP 書き出し。
 * スキーマ全体の CSV バックアップを 1 ファイルにまとめるために使う。
 *
 * 外部ライブラリを増やさずに済むよう、Node 標準の zlib だけで組み立てる。
 * 対応するのは deflate 圧縮の通常エントリのみ。
 * 4GB を超える書庫 (ZIP64) には対応しない。
 */

const zlib = require('zlib');

/* CRC-32 (ZIP のチェックサム) */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** JS の Date を DOS の日付・時刻形式にする。 */
function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * ZIP を組み立てる。
 * `add()` でファイルを足し、`end()` で書庫全体のバッファを得る。
 * 大きなテーブルでも 1 ファイルずつ圧縮するので、全件をまとめて持たずに済む。
 */
class ZipBuilder {
  constructor() {
    this.chunks = [];
    this.entries = [];
    this.offset = 0;
  }

  /** ファイルを 1 つ追加する。name は ZIP 内のパス。 */
  add(name, contentBuffer, date = new Date()) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(contentBuffer);
    const deflated = zlib.deflateRawSync(contentBuffer, { level: 6 });
    const { time, date: dosDate } = dosDateTime(date);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // ローカルファイルヘッダ
    local.writeUInt16LE(20, 4);           // 展開に必要なバージョン
    local.writeUInt16LE(0x0800, 6);       // ファイル名が UTF-8 であることを示す
    local.writeUInt16LE(8, 8);            // 圧縮方式: deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(contentBuffer.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // 拡張フィールドなし

    this.entries.push({
      nameBuf, crc, compressedSize: deflated.length,
      size: contentBuffer.length, offset: this.offset, time, dosDate,
    });

    this.chunks.push(local, nameBuf, deflated);
    this.offset += local.length + nameBuf.length + deflated.length;
  }

  /** 書庫を閉じてバッファを返す。 */
  end() {
    const centralStart = this.offset;
    const central = [];

    for (const e of this.entries) {
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0);  // セントラルディレクトリ
      head.writeUInt16LE(20, 4);          // 作成バージョン
      head.writeUInt16LE(20, 6);          // 展開に必要なバージョン
      head.writeUInt16LE(0x0800, 8);      // UTF-8 フラグ
      head.writeUInt16LE(8, 10);          // deflate
      head.writeUInt16LE(e.time, 12);
      head.writeUInt16LE(e.dosDate, 14);
      head.writeUInt32LE(e.crc, 16);
      head.writeUInt32LE(e.compressedSize, 20);
      head.writeUInt32LE(e.size, 24);
      head.writeUInt16LE(e.nameBuf.length, 28);
      head.writeUInt16LE(0, 30);          // 拡張フィールド
      head.writeUInt16LE(0, 32);          // コメント
      head.writeUInt16LE(0, 34);          // ディスク番号
      head.writeUInt16LE(0, 36);          // 内部属性
      head.writeUInt32LE(0, 38);          // 外部属性
      head.writeUInt32LE(e.offset, 42);
      central.push(head, e.nameBuf);
    }

    const centralBuf = Buffer.concat(central);

    const endRecord = Buffer.alloc(22);
    endRecord.writeUInt32LE(0x06054b50, 0);      // 終端レコード
    endRecord.writeUInt16LE(0, 4);               // このディスクの番号
    endRecord.writeUInt16LE(0, 6);               // 開始ディスク
    endRecord.writeUInt16LE(this.entries.length, 8);
    endRecord.writeUInt16LE(this.entries.length, 10);
    endRecord.writeUInt32LE(centralBuf.length, 12);
    endRecord.writeUInt32LE(centralStart, 16);
    endRecord.writeUInt16LE(0, 20);              // コメント長

    return Buffer.concat([...this.chunks, centralBuf, endRecord]);
  }
}

module.exports = { ZipBuilder, crc32 };
