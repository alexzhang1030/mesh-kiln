export type PreviewShading = 'lit' | 'unlit';

export type PreviewInspect = 'result' | 'mesh' | 'baseColor' | 'normal' | 'roughness' | 'metallic' | 'occlusion';

export type PreviewLook =
	| { kind: 'original' }
	| { kind: 'mesh' }
	| { kind: 'color'; lit: boolean }
	| { kind: 'normal' }
	| { kind: 'roughness' }
	| { kind: 'metallic' }
	| { kind: 'occlusion' };

export function previewLook(inspect: PreviewInspect, shading: PreviewShading): PreviewLook {
	switch (inspect) {
		case 'mesh':
			return { kind: 'mesh' };
		case 'normal':
			return { kind: 'normal' };
		case 'roughness':
			return { kind: 'roughness' };
		case 'metallic':
			return { kind: 'metallic' };
		case 'occlusion':
			return { kind: 'occlusion' };
		case 'baseColor':
			return { kind: 'color', lit: shading === 'lit' };
		case 'result':
			return shading === 'unlit' ? { kind: 'color', lit: false } : { kind: 'original' };
		default: {
			const exhausted: never = inspect;
			return exhausted;
		}
	}
}
