const fs = require('node:fs');
const path = require('node:path');
const { createCanvas } = require('@napi-rs/canvas');

const root = path.resolve(__dirname, '..');
const assetsDir = path.join(root, 'app', 'assets');
const pngPath = path.join(assetsDir, 'icon.png');
const icoPath = path.join(assetsDir, 'icon.ico');

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);

  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawBackground(ctx, size) {
  const inset = size * 0.07;
  const tileSize = size - (inset * 2);
  const radius = size * 0.22;

  ctx.save();
  ctx.shadowColor = 'rgba(10, 30, 45, 0.22)';
  ctx.shadowBlur = size * 0.08;
  ctx.shadowOffsetY = size * 0.025;
  roundedRect(ctx, inset, inset, tileSize, tileSize, radius);
  const baseGradient = ctx.createLinearGradient(inset, inset, inset + tileSize, inset + tileSize);
  baseGradient.addColorStop(0, '#163c5a');
  baseGradient.addColorStop(0.55, '#115f6e');
  baseGradient.addColorStop(1, '#0c2e43');
  ctx.fillStyle = baseGradient;
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundedRect(ctx, inset, inset, tileSize, tileSize, radius);
  ctx.clip();

  const warmGlow = ctx.createRadialGradient(size * 0.2, size * 0.18, size * 0.04, size * 0.2, size * 0.18, size * 0.62);
  warmGlow.addColorStop(0, 'rgba(255, 206, 125, 0.55)');
  warmGlow.addColorStop(0.55, 'rgba(255, 170, 76, 0.18)');
  warmGlow.addColorStop(1, 'rgba(255, 170, 76, 0)');
  ctx.fillStyle = warmGlow;
  ctx.fillRect(inset, inset, tileSize, tileSize);

  const coolGlow = ctx.createRadialGradient(size * 0.82, size * 0.84, size * 0.05, size * 0.82, size * 0.84, size * 0.56);
  coolGlow.addColorStop(0, 'rgba(98, 227, 228, 0.25)');
  coolGlow.addColorStop(1, 'rgba(98, 227, 228, 0)');
  ctx.fillStyle = coolGlow;
  ctx.fillRect(inset, inset, tileSize, tileSize);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = Math.max(1, size * 0.008);
  ctx.beginPath();
  ctx.moveTo(size * 0.16, size * 0.3);
  ctx.lineTo(size * 0.84, size * 0.3);
  ctx.moveTo(size * 0.22, size * 0.75);
  ctx.lineTo(size * 0.8, size * 0.75);
  ctx.stroke();

  ctx.restore();
}

function drawStrand(ctx, size, color, startX, startY, hubX, hubY) {
  ctx.save();
  ctx.lineCap = 'round';

  ctx.strokeStyle = 'rgba(7, 24, 37, 0.35)';
  ctx.lineWidth = size * 0.045;
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.bezierCurveTo(
    size * 0.24, startY,
    size * 0.27, hubY,
    hubX, hubY
  );
  ctx.stroke();

  ctx.strokeStyle = color;
  ctx.lineWidth = size * 0.023;
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.bezierCurveTo(
    size * 0.24, startY,
    size * 0.27, hubY,
    hubX, hubY
  );
  ctx.stroke();

  ctx.fillStyle = '#fdf6e5';
  ctx.beginPath();
  ctx.arc(startX, startY, size * 0.025, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(startX, startY, size * 0.012, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawHub(ctx, size, hubX, hubY) {
  ctx.save();

  ctx.fillStyle = '#f8efd8';
  ctx.beginPath();
  ctx.arc(hubX, hubY, size * 0.042, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#163c5a';
  ctx.beginPath();
  ctx.arc(hubX, hubY, size * 0.024, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.lineWidth = size * 0.006;
  ctx.beginPath();
  ctx.arc(hubX, hubY, size * 0.033, Math.PI * 0.85, Math.PI * 1.65);
  ctx.stroke();

  ctx.restore();
}

function drawDatabase(ctx, size, hubX, hubY) {
  const left = size * 0.46;
  const width = size * 0.34;
  const layerHeight = size * 0.09;
  const ellipseHeight = size * 0.07;
  const topY = size * 0.28;
  const layers = 3;

  ctx.save();

  ctx.strokeStyle = 'rgba(9, 28, 43, 0.12)';
  ctx.lineWidth = size * 0.018;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(hubX + size * 0.02, hubY);
  ctx.bezierCurveTo(
    size * 0.44, hubY,
    size * 0.45, size * 0.49,
    left, size * 0.49
  );
  ctx.stroke();

  const linkGradient = ctx.createLinearGradient(hubX, hubY, left, size * 0.49);
  linkGradient.addColorStop(0, '#ffc55f');
  linkGradient.addColorStop(1, '#ff8452');
  ctx.strokeStyle = linkGradient;
  ctx.lineWidth = size * 0.01;
  ctx.beginPath();
  ctx.moveTo(hubX + size * 0.02, hubY);
  ctx.bezierCurveTo(
    size * 0.44, hubY,
    size * 0.45, size * 0.49,
    left, size * 0.49
  );
  ctx.stroke();

  for (let index = 0; index < layers; index += 1) {
    const y = topY + (index * layerHeight * 1.1);
    const bodyTop = y + (ellipseHeight * 0.5);

    const bodyGradient = ctx.createLinearGradient(left, bodyTop, left + width, bodyTop + layerHeight);
    bodyGradient.addColorStop(0, '#fff6df');
    bodyGradient.addColorStop(1, '#ead9b6');
    ctx.fillStyle = bodyGradient;
    ctx.fillRect(left, bodyTop, width, layerHeight);

    ctx.beginPath();
    ctx.ellipse(left + (width / 2), y + (ellipseHeight * 0.5), width / 2, ellipseHeight / 2, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#fff8e7';
    ctx.fill();

    ctx.beginPath();
    ctx.ellipse(left + (width / 2), bodyTop + layerHeight, width / 2, ellipseHeight / 2, 0, 0, Math.PI);
    ctx.fillStyle = '#d9c49d';
    ctx.fill();

    ctx.strokeStyle = 'rgba(13, 44, 68, 0.18)';
    ctx.lineWidth = size * 0.006;
    ctx.beginPath();
    ctx.ellipse(left + (width / 2), y + (ellipseHeight * 0.5), width / 2, ellipseHeight / 2, 0, 0, Math.PI * 2);
    ctx.stroke();

    const ledY = bodyTop + (layerHeight * 0.52);
    const ledRadius = size * 0.008;
    const ledX = left + width - (size * 0.06);
    const colors = ['#41d7d4', '#ffc45e', '#ff7a7a'];
    colors.forEach((color, colorIndex) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(ledX - (colorIndex * size * 0.025), ledY, ledRadius, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  ctx.restore();
}

function drawSpark(ctx, size) {
  const x = size * 0.77;
  const y = size * 0.19;

  ctx.save();
  ctx.strokeStyle = '#ffdca0';
  ctx.lineWidth = size * 0.01;
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(x, y - (size * 0.035));
  ctx.lineTo(x, y + (size * 0.035));
  ctx.moveTo(x - (size * 0.035), y);
  ctx.lineTo(x + (size * 0.035), y);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255, 220, 160, 0.5)';
  ctx.lineWidth = size * 0.006;
  ctx.beginPath();
  ctx.moveTo(x - (size * 0.022), y - (size * 0.022));
  ctx.lineTo(x + (size * 0.022), y + (size * 0.022));
  ctx.moveTo(x + (size * 0.022), y - (size * 0.022));
  ctx.lineTo(x - (size * 0.022), y + (size * 0.022));
  ctx.stroke();

  ctx.restore();
}

function renderIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const hubX = size * 0.37;
  const hubY = size * 0.54;

  drawBackground(ctx, size);
  drawStrand(ctx, size, '#f9b24f', size * 0.16, size * 0.36, hubX, hubY);
  drawStrand(ctx, size, '#4fe1dc', size * 0.14, size * 0.53, hubX, hubY);
  drawStrand(ctx, size, '#ff8b68', size * 0.16, size * 0.7, hubX, hubY);
  drawHub(ctx, size, hubX, hubY);
  drawDatabase(ctx, size, hubX, hubY);
  drawSpark(ctx, size);

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

function main() {
  ensureDir(assetsDir);

  const pngSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoBuffers = pngSizes.map((size) => ({
    size,
    buffer: renderIcon(size)
  }));

  fs.writeFileSync(pngPath, renderIcon(512));
  fs.writeFileSync(icoPath, createIco(icoBuffers));

  console.log(`PNG: ${pngPath}`);
  console.log(`ICO: ${icoPath}`);
}

main();
