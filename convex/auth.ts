import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { getCurrentUserOrThrow } from "./users";

export async function requireAuth(ctx: QueryCtx): Promise<Doc<"users">> {
  return await getCurrentUserOrThrow(ctx);
}
