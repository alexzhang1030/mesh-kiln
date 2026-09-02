import { decode as decodePng, encode as encodePng } from 'fast-png';
import jpeg from 'jpeg-js';
import { clamp, wrap01 } from './math';
import type { RgbaImage } from './types';

export async function decodeImage(bytes: Uint8Array, mimeType: string | null): Promise<RgbaImage | null> {
	try {
		if (mimeType === 'image/webp' || isWebp(bytes)) {
			return await decodeWebp(bytes);
		}
		if (mimeType === 'image/jpeg' || mimeType === 'image/jpg' || isJpeg(bytes)) {
			const decoded = jpeg.decode(bytes, { useTArray: true });
			return { width: decoded.width, height: decoded.height, rgba: new Uint8Array(decoded.data) };
		}
		const decoded = decodePng(bytes);
		const rgba = toRgba8(decoded.width, decoded.height, decoded.data, decoded.channels ?? 4);
		return { width: decoded.width, height: decoded.height, rgba };
	} catch {
		return null;
	}
}

async function decodeWebp(bytes: Uint8Array): Promise<RgbaImage | null> {
	if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
		return null;
	}
	const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: 'image/webp' }));
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	const context = canvas.getContext('2d');
	if (!context) return null;
	context.drawImage(bitmap, 0, 0);
	const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
	bitmap.close();
	return { width: image.width, height: image.height, rgba: new Uint8Array(image.data) };
}

export function encodePngUncompressed(image: RgbaImage): Uint8Array {
	return encodePng(
		{
			width: image.width,
			height: image.height,
			data: image.rgba,
			depth: 8,
			channels: 4
		},
		{ zlib: { level: 0 } }
	);
}

export function sampleBilinear(image: RgbaImage, u: number, v: number, wrap = true): [number, number, number, number] {
	const uu = wrap ? wrap01(u) : clamp(u, 0, 1);
	const vv = wrap ? wrap01(v) : clamp(v, 0, 1);
	const x = uu * (image.width - 1);
	const y = vv * (image.height - 1);
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const x1 = Math.min(image.width - 1, x0 + 1);
	const y1 = Math.min(image.height - 1, y0 + 1);
	const tx = x - x0;
	const ty = y - y0;
	const c00 = pixel(image, x0, y0);
	const c10 = pixel(image, x1, y0);
	const c01 = pixel(image, x0, y1);
	const c11 = pixel(image, x1, y1);
	return [
		lerp(lerp(c00[0], c10[0], tx), lerp(c01[0], c11[0], tx), ty),
		lerp(lerp(c00[1], c10[1], tx), lerp(c01[1], c11[1], tx), ty),
		lerp(lerp(c00[2], c10[2], tx), lerp(c01[2], c11[2], tx), ty),
		lerp(lerp(c00[3], c10[3], tx), lerp(c01[3], c11[3], tx), ty)
	];
}

export function linearToSrgb(value: number): number {
	const x = clamp(value, 0, 1);
	return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

export function dilateRadiusForAtlas(size: number): number {
	return Math.max(8, Math.min(48, Math.round(size / 64)));
}

export function dilateRgba(image: RgbaImage, filled: Uint8Array, radius: number): void {
	const r = Math.max(0, Math.floor(radius));
	if (r <= 0) return;
	const { width, height, rgba } = image;
	const count = width * height;
	const dist = new Int32Array(count);
	dist.fill(-1);
	const qx = new Int32Array(count);
	const qy = new Int32Array(count);
	let head = 0;
	let tail = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = y * width + x;
			if (!filled[i]) continue;
			dist[i] = 0;
			qx[tail] = x;
			qy[tail] = y;
			tail += 1;
		}
	}
	while (head < tail) {
		const x = qx[head] ?? 0;
		const y = qy[head] ?? 0;
		head += 1;
		const i = y * width + x;
		const d = dist[i] ?? 0;
		if (d >= r) continue;
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				if (dx === 0 && dy === 0) continue;
				const nx = x + dx;
				const ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
				const ni = ny * width + nx;
				if ((dist[ni] ?? -1) >= 0) continue;
				dist[ni] = d + 1;
				const si = i * 4;
				const di = ni * 4;
				rgba[di] = rgba[si] ?? 0;
				rgba[di + 1] = rgba[si + 1] ?? 0;
				rgba[di + 2] = rgba[si + 2] ?? 0;
				rgba[di + 3] = rgba[si + 3] ?? 255;
				qx[tail] = nx;
				qy[tail] = ny;
				tail += 1;
			}
		}
	}
}

export function sharpenRgb(image: RgbaImage, amount: number, filled?: Uint8Array): void {
	if (amount <= 0) return;
	const { width, height, rgba } = image;
	if (width < 2 || height < 2) return;
	const src = rgba.slice();
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const index = y * width + x;
			if (filled && !filled[index]) continue;
			const i = index * 4;
			if ((src[i + 3] ?? 0) === 0) continue;
			let r = 0;
			let g = 0;
			let b = 0;
			let n = 0;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					if (dx === 0 && dy === 0) continue;
					const nx = x + dx;
					const ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
					const ni = ny * width + nx;
					if (filled && !filled[ni]) continue;
					const pi = ni * 4;
					if ((src[pi + 3] ?? 0) === 0) continue;
					r += src[pi] ?? 0;
					g += src[pi + 1] ?? 0;
					b += src[pi + 2] ?? 0;
					n += 1;
				}
			}
			if (n === 0) continue;
			const or = src[i] ?? 0;
			const og = src[i + 1] ?? 0;
			const ob = src[i + 2] ?? 0;
			rgba[i] = clampByte(or + amount * (or - r / n));
			rgba[i + 1] = clampByte(og + amount * (og - g / n));
			rgba[i + 2] = clampByte(ob + amount * (ob - b / n));
		}
	}
}

function clampByte(value: number): number {
	return Math.round(clamp(value, 0, 255));
}

export function createImage(width: number, height: number, fill: [number, number, number, number]): RgbaImage {
	const rgba = new Uint8Array(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		rgba[i * 4] = fill[0];
		rgba[i * 4 + 1] = fill[1];
		rgba[i * 4 + 2] = fill[2];
		rgba[i * 4 + 3] = fill[3];
	}
	return { width, height, rgba };
}

function pixel(image: RgbaImage, x: number, y: number): [number, number, number, number] {
	const i = (y * image.width + x) * 4;
	return [image.rgba[i] ?? 0, image.rgba[i + 1] ?? 0, image.rgba[i + 2] ?? 0, image.rgba[i + 3] ?? 0];
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function isJpeg(bytes: Uint8Array): boolean {
	return bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function isWebp(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	);
}

function toRgba8(width: number, height: number, data: ArrayLike<number>, channels: number): Uint8Array {
	const count = width * height;
	const rgba = new Uint8Array(count * 4);
	const max = data instanceof Uint16Array ? 65535 : 255;
	for (let i = 0; i < count; i++) {
		const src = i * channels;
		const r = data[src] ?? 0;
		const g = channels > 1 ? (data[src + 1] ?? r) : r;
		const b = channels > 2 ? (data[src + 2] ?? r) : r;
		const a = channels > 3 ? (data[src + 3] ?? max) : max;
		rgba[i * 4] = Math.round((r / max) * 255);
		rgba[i * 4 + 1] = Math.round((g / max) * 255);
		rgba[i * 4 + 2] = Math.round((b / max) * 255);
		rgba[i * 4 + 3] = Math.round((a / max) * 255);
	}
	return rgba;
}

export function encodeNormal(x: number, y: number, z: number): [number, number, number] {
	return [
		Math.round(clamp(x * 0.5 + 0.5, 0, 1) * 255),
		Math.round(clamp(y * 0.5 + 0.5, 0, 1) * 255),
		Math.round(clamp(z * 0.5 + 0.5, 0, 1) * 255)
	];
}
