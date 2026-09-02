export type Vec3 = [number, number, number];

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function vec3Create(x = 0, y = 0, z = 0): Vec3 {
	return [x, y, z];
}

export function vec3Copy(v: Vec3): Vec3 {
	return [v[0], v[1], v[2]];
}

export function vec3Add(a: Vec3, b: Vec3, out: Vec3): Vec3 {
	out[0] = a[0] + b[0];
	out[1] = a[1] + b[1];
	out[2] = a[2] + b[2];
	return out;
}

export function vec3Sub(a: Vec3, b: Vec3, out: Vec3): Vec3 {
	out[0] = a[0] - b[0];
	out[1] = a[1] - b[1];
	out[2] = a[2] - b[2];
	return out;
}

export function vec3Scale(a: Vec3, s: number, out: Vec3): Vec3 {
	out[0] = a[0] * s;
	out[1] = a[1] * s;
	out[2] = a[2] * s;
	return out;
}

export function vec3Dot(a: Vec3, b: Vec3): number {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vec3Cross(a: Vec3, b: Vec3, out: Vec3): Vec3 {
	const x = a[1] * b[2] - a[2] * b[1];
	const y = a[2] * b[0] - a[0] * b[2];
	const z = a[0] * b[1] - a[1] * b[0];
	out[0] = x;
	out[1] = y;
	out[2] = z;
	return out;
}

export function vec3Len(a: Vec3): number {
	return Math.hypot(a[0], a[1], a[2]);
}

export function vec3Normalize(a: Vec3, out: Vec3): Vec3 {
	const len = vec3Len(a);
	if (len <= 1e-12) {
		out[0] = 0;
		out[1] = 1;
		out[2] = 0;
		return out;
	}
	return vec3Scale(a, 1 / len, out);
}

export function readVec3(src: Float32Array, index: number, out: Vec3): Vec3 {
	const o = index * 3;
	out[0] = src[o] ?? 0;
	out[1] = src[o + 1] ?? 0;
	out[2] = src[o + 2] ?? 0;
	return out;
}

export function writeVec3(dest: Float32Array, index: number, v: Vec3): void {
	const o = index * 3;
	dest[o] = v[0];
	dest[o + 1] = v[1];
	dest[o + 2] = v[2];
}

export function readVec2(src: Float32Array, index: number): [number, number] {
	const o = index * 2;
	return [src[o] ?? 0, src[o + 1] ?? 0];
}

export type Aabb = {
	min: Vec3;
	max: Vec3;
};

export function aabbFromPositions(positions: Float32Array): Aabb {
	const min: Vec3 = [Infinity, Infinity, Infinity];
	const max: Vec3 = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < positions.length; i += 3) {
		const x = positions[i] ?? 0;
		const y = positions[i + 1] ?? 0;
		const z = positions[i + 2] ?? 0;
		if (x < min[0]) min[0] = x;
		if (y < min[1]) min[1] = y;
		if (z < min[2]) min[2] = z;
		if (x > max[0]) max[0] = x;
		if (y > max[1]) max[1] = y;
		if (z > max[2]) max[2] = z;
	}
	return { min, max };
}

export function aabbDiagonal(box: Aabb): number {
	return Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
}

export function meanEdgeLength(positions: Float32Array, indices: Uint32Array): number {
	let sum = 0;
	let count = 0;
	for (let i = 0; i + 2 < indices.length; i += 3) {
		const ia = (indices[i] ?? 0) * 3;
		const ib = (indices[i + 1] ?? 0) * 3;
		const ic = (indices[i + 2] ?? 0) * 3;
		const ax = positions[ia] ?? 0;
		const ay = positions[ia + 1] ?? 0;
		const az = positions[ia + 2] ?? 0;
		const bx = positions[ib] ?? 0;
		const by = positions[ib + 1] ?? 0;
		const bz = positions[ib + 2] ?? 0;
		const cx = positions[ic] ?? 0;
		const cy = positions[ic + 1] ?? 0;
		const cz = positions[ic + 2] ?? 0;
		sum += Math.hypot(bx - ax, by - ay, bz - az);
		sum += Math.hypot(cx - bx, cy - by, cz - bz);
		sum += Math.hypot(ax - cx, ay - cy, az - cz);
		count += 3;
	}
	return count === 0 ? 0 : sum / count;
}

export function aabbCenter(box: Aabb): Vec3 {
	return [
		(box.min[0] + box.max[0]) * 0.5,
		(box.min[1] + box.max[1]) * 0.5,
		(box.min[2] + box.max[2]) * 0.5
	];
}

export function mulMat4Vec3(
	m: Float32Array | number[],
	v: Vec3,
	out: Vec3,
	asDirection = false
): Vec3 {
	const w = asDirection ? 0 : 1;
	const x = (m[0] ?? 1) * v[0] + (m[4] ?? 0) * v[1] + (m[8] ?? 0) * v[2] + (m[12] ?? 0) * w;
	const y = (m[1] ?? 0) * v[0] + (m[5] ?? 1) * v[1] + (m[9] ?? 0) * v[2] + (m[13] ?? 0) * w;
	const z = (m[2] ?? 0) * v[0] + (m[6] ?? 0) * v[1] + (m[10] ?? 1) * v[2] + (m[14] ?? 0) * w;
	out[0] = x;
	out[1] = y;
	out[2] = z;
	return out;
}

export function mulMat4(a: number[], b: number[], out: number[]): number[] {
	for (let col = 0; col < 4; col++) {
		for (let row = 0; row < 4; row++) {
			out[col * 4 + row] =
				(a[row] ?? 0) * (b[col * 4] ?? 0) +
				(a[row + 4] ?? 0) * (b[col * 4 + 1] ?? 0) +
				(a[row + 8] ?? 0) * (b[col * 4 + 2] ?? 0) +
				(a[row + 12] ?? 0) * (b[col * 4 + 3] ?? 0);
		}
	}
	return out;
}

export function composeTrs(translation: Vec3, rotation: number[], scale: Vec3): number[] {
	const x = rotation[0] ?? 0;
	const y = rotation[1] ?? 0;
	const z = rotation[2] ?? 0;
	const w = rotation[3] ?? 1;
	const x2 = x + x;
	const y2 = y + y;
	const z2 = z + z;
	const xx = x * x2;
	const xy = x * y2;
	const xz = x * z2;
	const yy = y * y2;
	const yz = y * z2;
	const zz = z * z2;
	const wx = w * x2;
	const wy = w * y2;
	const wz = w * z2;
	const sx = scale[0];
	const sy = scale[1];
	const sz = scale[2];
	return [
		(1 - (yy + zz)) * sx,
		(xy + wz) * sx,
		(xz - wy) * sx,
		0,
		(xy - wz) * sy,
		(1 - (xx + zz)) * sy,
		(yz + wx) * sy,
		0,
		(xz + wy) * sz,
		(yz - wx) * sz,
		(1 - (xx + yy)) * sz,
		0,
		translation[0],
		translation[1],
		translation[2],
		1
	];
}

export function invertMat4(m: number[]): number[] | null {
	const out = new Array<number>(16).fill(0);
	const a00 = m[0] ?? 0;
	const a01 = m[1] ?? 0;
	const a02 = m[2] ?? 0;
	const a03 = m[3] ?? 0;
	const a10 = m[4] ?? 0;
	const a11 = m[5] ?? 0;
	const a12 = m[6] ?? 0;
	const a13 = m[7] ?? 0;
	const a20 = m[8] ?? 0;
	const a21 = m[9] ?? 0;
	const a22 = m[10] ?? 0;
	const a23 = m[11] ?? 0;
	const a30 = m[12] ?? 0;
	const a31 = m[13] ?? 0;
	const a32 = m[14] ?? 0;
	const a33 = m[15] ?? 0;

	const b00 = a00 * a11 - a01 * a10;
	const b01 = a00 * a12 - a02 * a10;
	const b02 = a00 * a13 - a03 * a10;
	const b03 = a01 * a12 - a02 * a11;
	const b04 = a01 * a13 - a03 * a11;
	const b05 = a02 * a13 - a03 * a12;
	const b06 = a20 * a31 - a21 * a30;
	const b07 = a20 * a32 - a22 * a30;
	const b08 = a20 * a33 - a23 * a30;
	const b09 = a21 * a32 - a22 * a31;
	const b10 = a21 * a33 - a23 * a31;
	const b11 = a22 * a33 - a23 * a32;

	let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
	if (Math.abs(det) < 1e-12) return null;
	det = 1 / det;

	out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
	out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
	out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
	out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
	out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
	out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
	out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
	out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
	out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
	out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
	out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
	out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
	out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
	out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
	out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
	out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
	return out;
}

export function transposeMat4(m: number[]): number[] {
	return [
		m[0] ?? 0,
		m[4] ?? 0,
		m[8] ?? 0,
		m[12] ?? 0,
		m[1] ?? 0,
		m[5] ?? 0,
		m[9] ?? 0,
		m[13] ?? 0,
		m[2] ?? 0,
		m[6] ?? 0,
		m[10] ?? 0,
		m[14] ?? 0,
		m[3] ?? 0,
		m[7] ?? 0,
		m[11] ?? 0,
		m[15] ?? 0
	];
}

export function wrap01(value: number): number {
	return value - Math.floor(value);
}
