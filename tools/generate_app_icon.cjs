const fs = require('node:fs');
const path = require('node:path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const root = path.resolve(__dirname, '..');
const assetsDir = path.join(root, 'app', 'assets');
const sourcePath = path.join(assetsDir, 'icon-source.png');
const pngPath = path.join(assetsDir, 'icon.png');
const icoPath = path.join(assetsDir, 'icon.ico');

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function renderFromSource(image, size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  const sourceSize = Math.min(image.width, image.height);
  const sourceX = Math.floor((image.width - sourceSize) / 2);
  const sourceY = Math.floor((image.height - sourceSize) / 2);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size);

  return canvas.toBuffer('image/png');
}

function createIco(pngEntries) {
  const headerSize = 6 + (16 * pngEntries.length);
  const totalSize = headerSize + pngEntries.reduce((sum, entry) => sum + entry.buffer.length, 0);
  const fileBuffer = Buffer.alloc(totalSize);

  fileBuffer.writeUInt16LE(0, 0);
  fileBuffer.writeUInt16LE(1, 2);
  fileBuffer.writeUInt16LE(pngEntries.length, 4);

  let directoryOffset = 6;
  let imageOffset = headerSize;

  for (const entry of pngEntries) {
    const dimensionByte = entry.size >= 256 ? 0 : entry.size;
    fileBuffer.writeUInt8(dimensionByte, directoryOffset);
    fileBuffer.writeUInt8(dimensionByte, directoryOffset + 1);
    fileBuffer.writeUInt8(0, directoryOffset + 2);
    fileBuffer.writeUInt8(0, directoryOffset + 3);
    fileBuffer.writeUInt16LE(1, directoryOffset + 4);
    fileBuffer.writeUInt16LE(32, directoryOffset + 6);
    fileBuffer.writeUInt32LE(entry.buffer.length, directoryOffset + 8);
    fileBuffer.writeUInt32LE(imageOffset, directoryOffset + 12);
    entry.buffer.copy(fileBuffer, imageOffset);

    directoryOffset += 16;
    imageOffset += entry.buffer.length;
  }

  return fileBuffer;
}

async function main() {
  ensureDir(assetsDir);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`No se encuentra la imagen fuente del icono: ${sourcePath}`);
  }

  const image = await loadImage(sourcePath);
  const pngSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoBuffers = pngSizes.map((size) => ({
    size,
    buffer: renderFromSource(image, size)
  }));

  fs.writeFileSync(pngPath, renderFromSource(image, 512));
  fs.writeFileSync(icoPath, createIco(icoBuffers));

  console.log(`SOURCE: ${sourcePath}`);
  console.log(`PNG: ${pngPath}`);
  console.log(`ICO: ${icoPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
