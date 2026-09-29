import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const text = z.string().max(2048);
export const querySchema = z.object({
  view: z.enum(["days", "projects", "status"]).default("days"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value);
  }, "Use a real calendar date").optional(),
  project: z.string().min(1).max(2048).optional(),
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(20).default(7),
}).strict();
export type Query = z.infer<typeof querySchema>;
export const requestSchema = querySchema.extend({ hostId: z.string().min(1).optional() });
const projectSchema = z.object({ path: text, name: text, focusMinutes: z.number(), sessionCount: z.number() });
const sessionSchema = z.object({
  id: text, source: text, machine: text, branch: text.nullable(), start: text, end: text,
  firstPrompt: text.nullable(), summary: text.nullable(),
});
export const reportSchema = z.object({
  source: z.enum(["plugin setting", "Trails collector", "local hub"]),
  fetchedAt: z.string(), timezone: text.nullable(), revision: z.number().nullable(),
  total: z.number(), nextOffset: z.number().nullable(), warnings: z.array(text).max(10),
  days: z.array(z.object({
    date: text, focusMinutes: z.number(), sessionCount: z.number(),
    sessions: z.array(sessionSchema).max(10),
    projects: z.array(projectSchema.extend({ summary: text.nullable() })).max(30), projectCount: z.number(),
  })).max(20),
  projects: z.array(projectSchema.extend({
    latestAt: text, sessions: z.array(sessionSchema).max(10),
  })).max(20),
  machines: z.array(z.object({
    name: text, lastCheckedAt: text.nullable(), lastIngestedAt: text.nullable(),
    lastProcessedAt: text.nullable(), lastError: text.nullable(),
  })).max(100),
  summaries: z.object({ selection: text, harness: text.nullable(), state: text,
    lastSuccessAt: z.number().nullable(), lastErrorClass: text.nullable(),
  }).nullable(),
});
export type Report = z.infer<typeof reportSchema>;
export const hostContract = defineRpcContract({
  query: { input: querySchema.extend({ serverUrl: z.string().max(2048), repoPaths: z.array(z.string().min(1).max(2048)).min(1).max(1000).optional() }), output: reportSchema },
});
export const rpcContract = defineRpcContract({
  query: { input: requestSchema, output: reportSchema },
  threadQuery: {
    input: querySchema.omit({ project: true }).extend({
      threadId: z.string().min(1), view: z.enum(["days", "projects"]).default("days"),
    }).strict(),
    output: z.object({ repository: text, report: reportSchema }),
  },
  hosts: { input: z.null(), output: z.object({
    hosts: z.array(z.object({ id: z.string(), name: z.string() })), defaultHostId: z.string().nullable(),
  }) },
});
