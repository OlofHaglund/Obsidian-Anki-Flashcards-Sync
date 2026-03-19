import {describe, expect, it} from "vitest";
import {__syncTestables} from "./sync";

describe("sync helpers", () => {
	it("normalizes wiki links and markdown links to raw audio path", () => {
		expect(__syncTestables.normalizeAudioLinkValue("[[ca-va.wav]]")).toBe("ca-va.wav");
		expect(__syncTestables.normalizeAudioLinkValue("![[Audio/ca-va.wav|Play]]")).toBe("Audio/ca-va.wav");
		expect(__syncTestables.normalizeAudioLinkValue("[Play](Audio/ca va.wav \"title\")")).toBe("Audio/ca va.wav");
	});

	it("detects existing Anki sound tokens", () => {
		expect(__syncTestables.containsAnkiSoundToken("[sound:ca-va.wav]")).toBe(true);
		expect(__syncTestables.containsAnkiSoundToken("[SOUND:ca-va.wav]")).toBe(true);
		expect(__syncTestables.containsAnkiSoundToken("ca-va.wav")).toBe(false);
	});

	it("accepts supported audio extensions", () => {
		expect(__syncTestables.isSupportedAudioPath("x.wav")).toBe(true);
		expect(__syncTestables.isSupportedAudioPath("x.MP3")).toBe(true);
		expect(__syncTestables.isSupportedAudioPath("x.txt")).toBe(false);
	});

	it("builds deterministic media file names", () => {
		const first = __syncTestables.buildAnkiMediaName("Audio/ca va.wav");
		const second = __syncTestables.buildAnkiMediaName("Audio/ca va.wav");
		const other = __syncTestables.buildAnkiMediaName("Audio/autre.wav");

		expect(first).toBe(second);
		expect(first).toMatch(/^obsidian-anki-ca_va-[0-9a-f]+\.wav$/);
		expect(other).not.toBe(first);
	});

	it("builds default card template when cards are missing", () => {
		expect(__syncTestables.buildAnkiCardTemplates([], ["Front", "Back"])).toEqual([
			{
				Name: "Card 1",
				Front: "{{Front}}",
				Back: "{{FrontSide}}<hr id=answer>{{Back}}",
			},
		]);
	});

	it("extracts flashcard blocks with stable indices", () => {
		const markdown = [
			"Some text",
			"```flashcard",
			"deck: A",
			"```",
			"",
			"```flashcard",
			"deck: B",
			"```",
		].join("\n");

		const blocks = __syncTestables.extractFlashcardBlocks(markdown);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]?.blockIndex).toBe(0);
		expect(blocks[1]?.blockIndex).toBe(1);
		expect(blocks[0]?.source).toContain("deck: A");
		expect(blocks[1]?.source).toContain("deck: B");
	});
});
