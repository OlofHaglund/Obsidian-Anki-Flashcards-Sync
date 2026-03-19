import {vi} from "vitest";

export class Plugin {}

export class TFile {
	path: string;

	constructor(path: string) {
		this.path = path;
	}
}

export const parseYaml = vi.fn((_raw: string): unknown => {
	throw new Error("parseYaml mock not configured for this test.");
});

export const requestUrl = vi.fn();
