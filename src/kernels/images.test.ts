import { describe, expect, it } from 'vitest';
import { createImage, dilateRadiusForAtlas, dilateRgba, linearToSrgb, sampleBilinear } from './images';

describe('glTF texture sampling', () => {
	it('maps UV origin to the upper-left image texel', () => {
		const image = createImage(2, 2, [0, 0, 0, 255]);
		image.rgba.set([
			220, 20, 20, 255, 220, 20, 20, 255,
			20, 20, 220, 255, 20, 20, 220, 255
		]);

		expect(sampleBilinear(image, 0.5, 0, false).slice(0, 3)).toEqual([220, 20, 20]);
		expect(sampleBilinear(image, 0.5, 1, false).slice(0, 3)).toEqual([20, 20, 220]);
	});
});

describe('sRGB encoding', () => {
	it('encodes linear 0.214 as an sRGB mid-grey byte', () => {
		expect(linearToSrgb(0)).toBe(0);
		expect(linearToSrgb(1)).toBeCloseTo(1, 10);
		expect(Math.round(linearToSrgb(0.214) * 255)).toBeGreaterThan(120);
		expect(Math.round(linearToSrgb(0.214) * 255)).toBeLessThan(140);
	});
});

describe('atlas dilation', () => {
	it('writes bleed pixels outside charts and leaves the chart mask alone', () => {
		expect(dilateRadiusForAtlas(2048)).toBe(32);
		expect(dilateRadiusForAtlas(64)).toBe(8);

		const image = createImage(8, 8, [0, 0, 0, 0]);
		const filled = new Uint8Array(8 * 8);
		for (let y = 3; y <= 4; y++) {
			for (let x = 3; x <= 4; x++) {
				const i = y * 8 + x;
				filled[i] = 1;
				image.rgba[i * 4] = 200;
				image.rgba[i * 4 + 1] = 10;
				image.rgba[i * 4 + 2] = 10;
				image.rgba[i * 4 + 3] = 255;
			}
		}
		const maskBefore = filled.slice();

		dilateRgba(image, filled, 2);

		expect(Array.from(filled)).toEqual(Array.from(maskBefore));

		const bleed = (x: number, y: number) => {
			const i = (y * 8 + x) * 4;
			return [image.rgba[i], image.rgba[i + 1], image.rgba[i + 2], image.rgba[i + 3]];
		};

		expect(bleed(4, 4)).toEqual([200, 10, 10, 255]);
		expect(bleed(5, 3)).toEqual([200, 10, 10, 255]);
		expect(bleed(5, 5)).toEqual([200, 10, 10, 255]);
		expect(bleed(2, 2)).toEqual([200, 10, 10, 255]);
		expect(bleed(7, 7)).toEqual([0, 0, 0, 0]);
		expect(bleed(0, 0)).toEqual([0, 0, 0, 0]);
	});
});
