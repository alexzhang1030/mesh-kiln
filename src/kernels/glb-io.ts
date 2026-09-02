import { WebIO } from '@gltf-transform/core';
import { EXTTextureWebP, KHRMaterialsSpecular, KHRMaterialsUnlit } from '@gltf-transform/extensions';

export function createGlbIo(): WebIO {
	return new WebIO().registerExtensions([EXTTextureWebP, KHRMaterialsSpecular, KHRMaterialsUnlit]);
}
