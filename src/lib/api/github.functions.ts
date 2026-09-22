import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { inspectGitHubRepository } from "../github-repo.server";

export const inspectGitHubRepo = createServerFn({ method: "POST" })
  .inputValidator(z.object({
    urlOrSlug: z.string().min(1),
    subpath: z.string().optional(),
  }))
  .handler(async ({ data }) => {
    return await inspectGitHubRepository(data.urlOrSlug, data.subpath);
  });
