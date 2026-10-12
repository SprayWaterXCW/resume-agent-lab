import { z } from "zod";
import { mappingProposalSchema } from "../core/fill-plan.js";

const id = z.string().min(1).max(140);
const target = z.object({ fieldId: id, sourcePath: id }).strict();
export const toolRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("observe"), args: z.object({ verifiedMappings: z.array(target).max(300).default([]) }).strict() }).strict(),
  z.object({ method: z.literal("inspect"), args: z.object({ fieldId: id }).strict() }).strict(),
  z.object({ method: z.literal("fill"), args: z.object({ item: target, retry: z.boolean(), proposal: mappingProposalSchema }).strict() }).strict(),
  z.object({ method: z.literal("add"), args: z.object({ groupId: id, proposal: mappingProposalSchema }).strict() }).strict(),
  z.object({ method: z.literal("audit"), args: z.object({ targets: z.array(target).max(300) }).strict() }).strict(),
  z.object({ method: z.literal("wait"), args: z.object({ milliseconds: z.number().int().min(100).max(1000) }).strict() }).strict(),
]);
export const startMessageSchema = z.object({ type: z.literal("start"), runId: z.string().uuid() }).strict();
