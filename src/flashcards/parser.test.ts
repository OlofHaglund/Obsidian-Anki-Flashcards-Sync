import {beforeEach, describe, expect, it, vi} from "vitest";
import {parseYaml} from "obsidian";
import {parseFlashcardBlock} from "./parser";

const parseYamlMock = vi.mocked(parseYaml);

describe("parseFlashcardBlock", () => {
	beforeEach(() => {
		parseYamlMock.mockReset();
	});

	it("parses legacy note_type with fields", () => {
		parseYamlMock.mockReturnValue({
			deck: "French::Sentences",
			note_type: "French Sentence",
			fields: ["french", "english", "Audio"],
		});

		const result = parseFlashcardBlock("ignored");
		expect(result.errors).toEqual([]);
		expect(result.config).toEqual({
			deck: "French::Sentences",
			note_type: {
				name: "French Sentence",
				fields: ["french", "english", "Audio"],
				cards: [],
				styling: "",
			},
		});
	});

	it("falls back to default note type when note_type is missing and fields exist", () => {
		parseYamlMock.mockReturnValue({
			deck: "French::Sentences",
			fields: ["front", "back"],
		});

		const result = parseFlashcardBlock("ignored");
		expect(result.errors).toEqual([]);
		expect(result.config?.note_type.name).toBe("Basic");
		expect(result.config?.note_type.fields).toEqual(["front", "back"]);
	});

	it("reports error when deck is missing", () => {
		parseYamlMock.mockReturnValue({
			note_type: "Basic",
			fields: ["front"],
		});

		const result = parseFlashcardBlock("ignored");
		expect(result.config).toBeUndefined();
		expect(result.errors).toContain("Missing required key: deck (string).");
	});

	it("reports parse errors from parseYaml", () => {
		parseYamlMock.mockImplementation(() => {
			throw new Error("invalid yaml");
		});

		const result = parseFlashcardBlock("not-yaml");
		expect(result.config).toBeUndefined();
		expect(result.errors[0]).toContain("Invalid YAML:");
	});

	it("requires note_type fields in object format", () => {
		parseYamlMock.mockReturnValue({
			deck: "French::Sentences",
			note_type: {
				name: "French Sentence",
			},
		});

		const result = parseFlashcardBlock("ignored");
		expect(result.config).toBeUndefined();
		expect(result.errors).toContain("Missing required key: note_type.fields (non-empty string array).");
	});
});
