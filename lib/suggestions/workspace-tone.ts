import type { WorkspaceTone } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import type { Tone, WorkspaceToneValue } from "./tone";
import { WORKSPACE_TONE_VALUES, resolveTone, toneToWorkspaceTone } from "./tone";

/**
 * The database side of the workspace tone.
 *
 * Split out of lib/suggestions/tone.ts so that everything else in the
 * suggestion library stays free of Prisma. Import this file only from a server
 * component, a route handler or the worker.
 */

// Drift guard. If a value is added to `enum WorkspaceTone` in the schema and
// not to WORKSPACE_TONE_VALUES, or the other way round, this stops compiling.
// It costs nothing at runtime and it is the only thing keeping the lowercase
// ids and the stored enum honest.
const _TONE_VALUES_MATCH_SCHEMA = WORKSPACE_TONE_VALUES satisfies readonly WorkspaceTone[];
type _SchemaToneIsCovered = WorkspaceTone extends WorkspaceToneValue ? true : never;
const _SCHEMA_TONE_IS_COVERED: _SchemaToneIsCovered = true;
void _TONE_VALUES_MATCH_SCHEMA;
void _SCHEMA_TONE_IS_COVERED;

/**
 * The tone this workspace writes in. Falls back to the default for a workspace
 * that does not exist, because a missing row is a reason to show friendly copy,
 * not a reason to fail a page render.
 */
export async function getWorkspaceToneById(workspaceId: string): Promise<Tone> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { tone: true },
  });

  return resolveTone(workspace?.tone);
}

/** Change the voice. One decision, applied forever, changeable later. */
export async function setWorkspaceTone(
  workspaceId: string,
  tone: Tone
): Promise<Tone> {
  const updated = await prisma.workspace.update({
    where: { id: workspaceId },
    data: { tone: toneToWorkspaceTone(tone) },
    select: { tone: true },
  });

  return resolveTone(updated.tone);
}
