/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAI, OutputMode, Raw, toMode } from '@vscode/prompt-tsx';
import { ChatCompletionContentPartKind } from '@vscode/prompt-tsx/dist/base/output/rawTypes';
import { TelemetryData } from '../../telemetry/common/telemetryData';
import { ICopilotReference, RequestId } from './fetch';

/**
 * How the logprobs field looks in the OpenAI API chunks.
 */
export interface APILogprobs {
	text_offset: number[];
	token_logprobs: number[];
	top_logprobs?: { [key: string]: number }[];
	tokens: string[];
}

/**
 * Usage statistics for the completion request.
 */
export interface APIUsage {
	/**
	 * Number of tokens in the prompt.
	 */
	prompt_tokens: number;
	/**
	 * Number of tokens in the generated completion.
	 */
	completion_tokens: number;
	/**
	 * Total number of tokens used in the request (prompt + completion).
	 */
	total_tokens: number;
	/**
	 * Breakdown of tokens used in the prompt.
	 */
	prompt_tokens_details: {
		cached_tokens: number;
	};
	/**
	 * Breakdown of tokens used in a completion.
	 *
	 * @remark it's an optional field because Copilot Proxy returns this information but not CAPI as of 18 Jun 2025
	 */
	completion_tokens_details?: {
		/**
		 * Tokens generated by the model for reasoning.
		 */
		reasoning_tokens: number;
		/**
		 * When using Predicted Outputs, the number of tokens in the prediction that appeared in the completion.
		 */
		accepted_prediction_tokens: number;
		/**
		 * When using Predicted Outputs, the number of tokens in the prediction that did not appear in the completion.
		 * However, like reasoning tokens, these tokens are still counted in the total completion tokens for purposes of billing,
		 * output, and context window limits.
		 */
		rejected_prediction_tokens: number;
	};
}

export function isApiUsage(obj: unknown): obj is APIUsage {
	return typeof (obj as APIUsage).prompt_tokens === 'number' &&
		typeof (obj as APIUsage).completion_tokens === 'number' &&
		typeof (obj as APIUsage).total_tokens === 'number';
}


export interface APIJsonData {
	text: string;
	/* Joining this together produces `text`, due to the way the proxy works. */
	tokens: readonly string[];
	/* These are only generated in certain situations. */
	logprobs?: APILogprobs;
}

export interface APIErrorResponse {
	code: number;
	message: string;
	metadata?: Record<string, any>;
}


export enum ChatRole {
	System = 'system',
	User = 'user',
	Assistant = 'assistant',
	Function = 'function',
	Tool = 'tool'
}


export type CAPIChatMessage = OpenAI.ChatMessage & {
	/**
	 * CAPI references used in this message.
	 */
	copilot_references?: ICopilotReference[];
	/**
	 * CAPI confirmations used in this message.
	 */
	copilot_confirmations?: { state: string; confirmation: any }[];

	copilot_cache_control?: {
		'type': 'ephemeral';
	};
};

export function getCAPITextPart(content: string | OpenAI.ChatCompletionContentPart[] | OpenAI.ChatCompletionContentPart): string {
	if (Array.isArray(content)) {
		return content.map((part) => getCAPITextPart(part)).join('');
	} else if (typeof content === 'string') {
		return content;
	} else if (typeof content === 'object' && 'text' in content) {
		return content.text;
	} else {
		return '';
	}
}

/**
 * Converts a raw TSX chat message to CAPI's format.
 *
 * **Extra:** the raw message can have `copilot_references` and
 * `copilot_confirmations` properties, which are copied to the CAPI message.
 */
export function rawMessageToCAPI(message: Raw.ChatMessage): CAPIChatMessage;
export function rawMessageToCAPI(message: Raw.ChatMessage[]): CAPIChatMessage[];
export function rawMessageToCAPI(message: Raw.ChatMessage[] | Raw.ChatMessage): CAPIChatMessage | CAPIChatMessage[] {
	if (Array.isArray(message)) {
		return message.map(m => rawMessageToCAPI(m));
	}

	const out: CAPIChatMessage = toMode(OutputMode.OpenAI, message);
	if ('copilot_references' in message) {
		out.copilot_references = (message as any).copilot_references;
	}
	if ('copilot_confirmations' in message) {
		out.copilot_confirmations = (message as any).copilot_confirmations;
	}
	if (typeof out.content === 'string') {
		out.content = out.content.trimEnd();
	} else {
		for (const part of out.content) {
			if (part.type === 'text') {
				part.text = part.text.trimEnd();
			}
		}
	}

	if (message.content.find(part => part.type === ChatCompletionContentPartKind.CacheBreakpoint)) {
		out.copilot_cache_control = { type: 'ephemeral' };
	}

	return out;
}

export enum FinishedCompletionReason {
	/**
	 * Reason generated by the server. See https://platform.openai.com/docs/guides/gpt/chat-completions-api
	 */
	Stop = 'stop',
	/**
	 * Reason generated by the server. See https://platform.openai.com/docs/guides/gpt/chat-completions-api
	 */
	Length = 'length',
	/**
	 * Reason generated by the server. See https://platform.openai.com/docs/guides/gpt/chat-completions-api
	 */
	FunctionCall = 'function_call',
	/**
	 * Reason generated by the server. See https://platform.openai.com/docs/guides/gpt/chat-completions-api
	 */
	ToolCalls = 'tool_calls',
	/**
	 * Reason generated by the server. See https://platform.openai.com/docs/guides/gpt/chat-completions-api
	 */
	ContentFilter = 'content_filter',
	/**
	 * Reason generated by the server (CAPI). Happens when the stream cannot be completed and the server must terminate the response.
	 */
	ServerError = 'error',
	/**
	 * Reason generated by the client when the finish callback asked for processing to stop.
	 */
	ClientTrimmed = 'client-trimmed',
	/**
	 * Reason generated by the client when we never received a finish_reason for this particular completion (indicates a server-side bug)
	 */
	ClientIterationDone = 'Iteration Done',
	/**
	 * Reason generated by the client when we never received a finish_reason for this particular completion (indicates a server-side bug)
	 */
	ClientDone = 'DONE',
}

export interface IToolCall {
	index: number;
	id?: string;
	function?: { name: string; arguments: string };
}

/**
 * Contains the possible reasons a response can be filtered
 */
export enum FilterReason {
	/**
	 * Content deemed to be hateful
	 */
	Hate = 'hate',
	/**
	 * Content deemed to cause self harm
	 */
	SelfHarm = 'self_harm',
	/**
	 * Content deemed to be sexual in nature
	 */
	Sexual = 'sexual',
	/**
	 * Content deemed to be violent in nature
	 */
	Violence = 'violence',
	/**
	 * Content contains copyrighted material
	 */
	Copyright = 'snippy',
	/**
	 * The prompt was filtered, the reason was not provided
	 */
	Prompt = 'prompt'
}

export interface ChatCompletion {
	message: Raw.ChatMessage;
	choiceIndex: number;
	requestId: RequestId;
	tokens: readonly string[];
	usage: APIUsage | undefined;
	blockFinished: boolean; // Whether the block completion was determined to be finished
	finishReason: FinishedCompletionReason;
	filterReason?: FilterReason; // optional filter reason if the completion was filtered
	telemetryData: TelemetryData; // optional telemetry data providing background
	error?: APIErrorResponse; // optional, error was encountered during the response
}

export interface ChoiceLogProbs {
	content: ChoiceLogProbsContent[];
}

interface TokenLogProb {
	bytes: number[];
	token: string;
	logprob: number;
}

export interface ChoiceLogProbsContent extends TokenLogProb {
	top_logprobs: TokenLogProb[];
}
