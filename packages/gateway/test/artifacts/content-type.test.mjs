import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { detectContentType } from '../../src/artifacts/content-type.ts';

function zipWithEntries(names) {
  const local = []; const central = []; let offset = 0;
  for (const name of names) {
    const filename = Buffer.from(name, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6); directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length;
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10); end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

test('detects safe raster signatures instead of trusting browser MIME', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-sniff-'));
  try {
    const png = join(directory, 'fake.txt');
    writeFileSync(png, Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]));
    assert.deepEqual(detectContentType(png, 'text/plain'), { mediaType: 'image/png', previewKind: 'image', kind: 'image' });
    const pdf = join(directory, 'fake.jpg');
    writeFileSync(pdf, Buffer.from('%PDF-1.7\n'));
    assert.deepEqual(detectContentType(pdf, 'image/jpeg'), { mediaType: 'application/pdf', previewKind: 'unsupported', kind: 'document' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('keeps decodable text previewable and active content non-inline', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-sniff-text-'));
  try {
    const text = join(directory, 'notes'); writeFileSync(text, 'hello 世界\n');
    assert.equal(detectContentType(text, 'text/plain').previewKind, 'text');
    const svg = join(directory, 'vector'); writeFileSync(svg, '<svg onload="alert(1)"></svg>');
    assert.deepEqual(detectContentType(svg, 'image/svg+xml'), { mediaType: 'image/svg+xml', previewKind: 'unsupported', kind: 'file' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('recognizes OOXML containers from ZIP entries instead of trusting extension or declared MIME', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-sniff-ooxml-'));
  try {
    const cases = [
      ['word.bin', ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'],
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['sheet.bin', ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml'],
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['slides.bin', ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml'],
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ];
    for (const [name, entries, mediaType] of cases) {
      const path = join(directory, name); writeFileSync(path, zipWithEntries(entries));
      assert.deepEqual(detectContentType(path, 'application/zip'),
        { mediaType, previewKind: 'unsupported', kind: 'document' });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('keeps ordinary ZIP containers as files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ga-sniff-zip-'));
  try {
    const path = join(directory, 'archive.docx');
    writeFileSync(path, zipWithEntries(['notes.txt']));
    assert.deepEqual(detectContentType(path, 'application/zip'),
      { mediaType: 'application/zip', previewKind: 'unsupported', kind: 'file' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
