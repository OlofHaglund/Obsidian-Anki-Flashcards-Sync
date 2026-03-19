import {requestUrl} from "obsidian";

/**
 * AnkiConnect JSON-RPC envelope.
 */
interface AnkiConnectEnvelope<TParams> {
	action: string;
	version: number;
	params?: TParams;
}

/**
 * AnkiConnect response payload.
 */
interface AnkiConnectResponse<TResult> {
	result: TResult | null;
	error: string | null;
}

/**
 * HTTP client for talking to AnkiConnect.
 */
export class AnkiConnectClient {
	endpoint: string;

	constructor(endpoint: string) {
		this.endpoint = endpoint;
	}

	/**
	 * Sends an action request to AnkiConnect and returns typed result data.
	 */
	async request<TParams, TResult>(action: string, params?: TParams): Promise<TResult> {
		const payload: AnkiConnectEnvelope<TParams> = {
			action,
			version: 6,
			params,
		};

		const response = await requestUrl({
			url: this.endpoint,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});

		const parsed = response.json as AnkiConnectResponse<TResult>;
		if (parsed.error !== null) {
			throw new Error(`AnkiConnect error: ${parsed.error}`);
		}

		return parsed.result as TResult;
	}
}
