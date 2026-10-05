import * as z from "zod/v4";

export const modelSelectionSchema = z.object({
  instanceId: z.string(),
  model: z.string(),
  options: z
    .array(z.object({ id: z.string(), value: z.union([z.string(), z.boolean()]) }))
    .optional(),
});
export const providerModelSchema = z.object({
  slug: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).optional(),
  isDefault: z.boolean().optional(),
  isLegacy: z.boolean().optional(),
});
export const providerSchema = z.object({
  instanceId: z.string(),
  driver: z.string(),
  displayName: z.string().optional(),
  enabled: z.boolean(),
  installed: z.boolean(),
  version: z.string().nullable(),
  status: z.string(),
  auth: z.object({ status: z.string() }),
  message: z.string().optional(),
  availability: z.enum(["available", "unavailable"]).optional(),
  unavailableReason: z.string().optional(),
  models: z.array(providerModelSchema),
});
export const serverConfigSchema = z.object({ providers: z.array(providerSchema) });

export type ModelSelection = z.infer<typeof modelSelectionSchema>;
export type ProviderModel = z.infer<typeof providerModelSchema>;
export type Provider = z.infer<typeof providerSchema>;
export type ServerConfig = z.infer<typeof serverConfigSchema>;
