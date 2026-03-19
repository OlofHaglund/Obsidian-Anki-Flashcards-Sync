import {Notice, Plugin} from "obsidian";
import {registerFlashcardCodeBlockRenderer} from "./flashcards/renderer";
import {AnkiConnectClient} from "./anki/client";
import {syncFlashcardsFromVault} from "./anki/sync";
import {DEFAULT_SETTINGS, ObsidianAnkiPluginSettings, ObsidianAnkiSettingTab} from "./settings";

/**
 * Main plugin entrypoint.
 * Keeps lifecycle concerns in one place and delegates feature logic to modules.
 */
export default class ObsidianAnkiPlugin extends Plugin {
	settings: ObsidianAnkiPluginSettings;
	ankiClient: AnkiConnectClient;

	/**
	 * Loads configuration and registers plugin features.
	 */
	async onload(): Promise<void> {
		await this.loadSettings();
		this.ankiClient = new AnkiConnectClient(this.settings.ankiConnectUrl);

		this.addSettingTab(new ObsidianAnkiSettingTab(this.app, this));
		registerFlashcardCodeBlockRenderer(this);

		this.addCommand({
			id: "sync-flashcards-to-anki",
			name: "Sync flashcards to Anki",
			callback: async () => {
				try {
					const result = await syncFlashcardsFromVault(this, this.ankiClient, this.settings);
					const baseMessage = `Anki sync complete. Created: ${result.created}, Updated: ${result.updated}, Skipped: ${result.skipped}, Failed: ${result.failed}`;
					if (result.failed === 0) {
						new Notice(baseMessage);
						return;
					}

					const firstFailure = result.failures[0] ?? "Unknown failure.";
					new Notice(`${baseMessage}\nFirst error: ${firstFailure}`, 12000);
				} catch (error: unknown) {
					const message = error instanceof Error ? error.message : "Unknown sync failure.";
					new Notice(`Anki sync failed: ${message}`);
				}
			},
		});
	}

	/**
	 * Called by Obsidian when the plugin is unloaded.
	 */
	onunload(): void {
		// No explicit cleanup needed yet. Registered handlers are managed by Obsidian.
	}

	/**
	 * Loads persisted settings and merges with defaults.
	 */
	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData() as Partial<ObsidianAnkiPluginSettings>,
		);
	}

	/**
	 * Persists settings and updates the Anki client endpoint in memory.
	 */
	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.ankiClient = new AnkiConnectClient(this.settings.ankiConnectUrl);
	}
}
