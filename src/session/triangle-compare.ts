export type TriangleCompare =
	| { kind: 'reduced'; percent: number }
	| { kind: 'same' }
	| { kind: 'worse'; extra: number };

export function compareTriangleCounts(sourceCount: number, bakedCount: number): TriangleCompare {
	if (bakedCount > sourceCount) return { kind: 'worse', extra: bakedCount - sourceCount };
	if (bakedCount === sourceCount) return { kind: 'same' };
	return { kind: 'reduced', percent: (1 - bakedCount / sourceCount) * 100 };
}

export function triangleCompareKicker(compare: TriangleCompare): string {
	switch (compare.kind) {
		case 'reduced':
			return `${compare.percent.toFixed(1)}% reduction`;
		case 'same':
			return 'same tris';
		case 'worse':
			return `worse · +${compare.extra.toLocaleString()} tris`;
		default: {
			const exhausted: never = compare;
			return exhausted;
		}
	}
}
