/**
 * Simplified schema that only validates fields actually used in the codebase
 * while preserving all other fields through passthrough()
 */

import { z } from "zod";

// Usage statistics for assistant messages - used in apiSession.ts
export const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative(),
  service_tier: z.string().optional(),
}).passthrough();

// Main schema with minimal validation for only the fields we use
// NOTE: Schema is intentionally lenient to handle various Claude Code message formats
// including synthetic error messages, API errors, and different SDK versions
const UserRawJSONLinesSchema = z.object({
  type: z.literal("user"),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  uuid: z.string(), // Used in getMessageKey()
  message: z.object({
    content: z.union([z.string(), z.any()]) // Used in sessionScanner.ts
  }).passthrough()
}).passthrough();

const AssistantRawJSONLinesSchema = z.object({
  uuid: z.string(),
  type: z.literal("assistant"),
  message: z.object({
    usage: UsageSchema.optional(), // Used in apiSession.ts
  }).passthrough().optional()
}).passthrough();

const SummaryRawJSONLinesSchema = z.object({
  type: z.literal("summary"),
  summary: z.string(), // Used in apiSession.ts
  leafUuid: z.string() // Used in getMessageKey()
}).passthrough();

const SystemRawJSONLinesSchema = z.object({
  type: z.literal("system"),
  uuid: z.string() // Used in getMessageKey()
}).passthrough();

const UnknownRawJSONLinesSchema = z.object({
  type: z.string().min(1),
}).passthrough();

export const RawJSONLinesSchema = z.union([
  // User message - validates uuid and message.content
  UserRawJSONLinesSchema,

  // Assistant message - only validates uuid and type
  // message object is optional to handle synthetic error messages (isApiErrorMessage: true)
  // which may have different structure than normal assistant messages
  AssistantRawJSONLinesSchema,

  // Summary message - validates summary and leafUuid
  SummaryRawJSONLinesSchema,

  // System message - validates uuid
  SystemRawJSONLinesSchema,

  // Forward-compatible catch-all for newer Claude message types such as
  // result / tool_progress / rate_limit_event / progress.
  UnknownRawJSONLinesSchema
]);

export type RawJSONLines =
  | z.infer<typeof UserRawJSONLinesSchema>
  | z.infer<typeof AssistantRawJSONLinesSchema>
  | z.infer<typeof SummaryRawJSONLinesSchema>
  | z.infer<typeof SystemRawJSONLinesSchema>
  | z.infer<typeof UnknownRawJSONLinesSchema>
