declare module "indigo-ketcher" {
	export interface IndigoOptions {
		set(key: string, value: string): void;
		delete(): void;
	}
	export interface IndigoModule {
		MapStringString: new () => IndigoOptions;
		convert(structure: string, format: string, options: IndigoOptions): string;
		render(structure: string, options: IndigoOptions): string;
	}
	export default function createIndigo(): Promise<IndigoModule>;
}
