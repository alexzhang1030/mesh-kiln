export type ExampleSpec = {
	id: string;
	label: string;
	file: string;
};

export type ExampleId = ExampleSpec['id'];

/** Pixabay Content License GLBs in public/examples/. Short name only. See NOTICE.md. */
export const EXAMPLES: readonly ExampleSpec[] = [
	{ id: 'tower', label: 'Tower', file: '/examples/tower.glb' },
	{ id: 'car', label: 'Car', file: '/examples/car.glb' },
	{ id: 'dog', label: 'Dog', file: '/examples/dog.glb' },
	{ id: 'bear', label: 'Bear', file: '/examples/bear.glb' }
];

export function exampleById(id: ExampleId): ExampleSpec {
	const example = EXAMPLES.find((entry) => entry.id === id);
	if (!example) throw new Error(`Unknown example: ${id}`);
	return example;
}
