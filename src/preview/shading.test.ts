import { describe, expect, it } from 'vitest';
import { previewLook, type PreviewInspect, type PreviewShading } from './shading';

describe('previewLook', () => {
	it('keeps studio lighting on the original material for Lit + Result', () => {
		expect(previewLook('result', 'lit')).toEqual({ kind: 'original' });
	});

	it('shows unlit albedo for Unlit + Result', () => {
		expect(previewLook('result', 'unlit')).toEqual({ kind: 'color', lit: false });
	});

	it('keeps studio lighting on base color when Lit is on', () => {
		expect(previewLook('baseColor', 'lit')).toEqual({ kind: 'color', lit: true });
	});

	it('shows unlit albedo for Unlit + Base color', () => {
		expect(previewLook('baseColor', 'unlit')).toEqual({ kind: 'color', lit: false });
	});

	it('lights the gray mesh view in both shading modes', () => {
		expect(previewLook('mesh', 'lit')).toEqual({ kind: 'mesh' });
		expect(previewLook('mesh', 'unlit')).toEqual({ kind: 'mesh' });
	});

	it('keeps map debug channels unlit so Lit cannot wash them out', () => {
		const channels: PreviewInspect[] = ['normal', 'roughness', 'metallic', 'occlusion'];
		const modes: PreviewShading[] = ['lit', 'unlit'];
		for (const channel of channels) {
			for (const shading of modes) {
				expect(previewLook(channel, shading)).toEqual({ kind: channel });
			}
		}
	});
});
